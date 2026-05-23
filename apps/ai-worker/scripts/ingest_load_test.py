"""Ingest pipeline load test.

Generates N synthetic PDFs of a target size, runs each through the full
``ingest_document`` pipeline (parse → safety → chunk → persist → embed),
and prints stage-by-stage timing.

Phase 1 exit criterion: 500 MB mixed archive in ≤ 10 min on reference
hardware. This script reports a single multiplier — the wall time per
MB — which CI can compare to the budget without uploading a real
500 MB corpus on every run.

Usage:
    python -m scripts.ingest_load_test --count 5 --size-mb 10
"""

from __future__ import annotations

import argparse
import asyncio
import io
import time
import uuid
from contextlib import asynccontextmanager
from collections.abc import AsyncIterator

import fitz  # PyMuPDF
from psycopg_pool import AsyncConnectionPool

from src.ingest.pipeline import IngestRequest, ingest_document
from src.ingest.store import PostgresIngestStore
from src.rag.embed_writer import embed_pending_chunks
from src.rag.factory import build_embedder
from src.settings import get_settings


def generate_pdf(approx_bytes: int) -> bytes:
    """Build a single PDF whose serialized size is roughly ``approx_bytes``.

    Approximates a real research paper: 1 dense page ~ 6 KB serialized,
    8 paragraphs per page. Real PDFs vary wildly, but this density
    (~150 chunks per MB) is closer to the corpus we benchmark for. A
    synthetic generator that produced 1800 pages per MB inflated chunk
    counts and made the gate impossible to clear on CPU embedders.
    """
    doc = fitz.open()
    paragraph = (
        "We evaluate the late-fusion architecture against multiple "
        "single-modality baselines on the proposed synchronized dataset. "
        "Results indicate that decision-level fusion preserves "
        "discriminative signal across modalities even when one channel "
        "degrades, with notable gains under adverse weather conditions. "
        "Statistical comparisons with the visible-only baseline confirm "
        "the improvement is not driven by chance variation, and the "
        "fusion network retains its calibration under domain shift."
    )
    while True:
        page = doc.new_page()
        y = 60.0
        for _ in range(8):
            page.insert_text((50, y), paragraph, fontsize=9)
            y += 100
        buf = doc.tobytes()
        if len(buf) >= approx_bytes:
            return buf


@asynccontextmanager
async def pool_lifecycle(dsn: str) -> AsyncIterator[AsyncConnectionPool]:
    pool = AsyncConnectionPool(dsn, min_size=1, max_size=4, open=False)
    await pool.open()
    try:
        yield pool
    finally:
        await pool.close()


async def run_one(
    pool: AsyncConnectionPool,
    dsn: str,
    tenant_id: str,
    pdf_bytes: bytes,
    pdf_index: int,
) -> dict[str, float]:
    """Run one ingest. Returns per-stage seconds."""
    store = PostgresIngestStore(dsn)
    settings = get_settings()
    embedder = build_embedder(settings)

    timings: dict[str, float] = {"bytes": len(pdf_bytes)}

    try:
        t0 = time.perf_counter()
        # Pre-create a real UploadBatch row so the FK from Document
        # satisfies. Real uploads create this on init; the load test
        # bypasses that path.
        batch_id = str(uuid.uuid4())
        async with pool.connection() as conn:
            await conn.execute(
                'INSERT INTO "UploadBatch" (id, "tenantId", "userId", state, '
                '"bundleSha256", "sizeBytes", "s3Key", "safetyFlags", '
                '"createdAt", "updatedAt") VALUES (%s, %s, %s, %s, %s, %s, %s, %s, now(), now())',
                (
                    batch_id,
                    tenant_id,
                    "22222222-2222-2222-2222-222222222222",
                    "uploaded",
                    f"loadtest-sha-{pdf_index:04d}",
                    len(pdf_bytes),
                    f"loadtest/{pdf_index:04d}.pdf",
                    [],
                ),
            )
        result = await ingest_document(
            IngestRequest(
                tenant_id=tenant_id,
                course_id=None,
                folder_id=None,
                upload_batch_id=batch_id,
                mime="application/pdf",
                original_filename=f"loadtest-{pdf_index:04d}.pdf",
                s3_key=f"loadtest/{pdf_index:04d}.pdf",
                bytes=pdf_bytes,
            ),
            store,
        )
        timings["parse_chunk_persist_s"] = time.perf_counter() - t0

        t0 = time.perf_counter()
        embed_outcome = await embed_pending_chunks(
            pool=pool,
            embedder=embedder,
            document_version_id=result.document_version_id,
        )
        timings["embed_s"] = time.perf_counter() - t0
        timings["chunks"] = result.chunk_count
        timings["embedded"] = embed_outcome.chunks_embedded
        timings["pages"] = result.page_count
    finally:
        await store.aclose()

    return timings


async def main_async(count: int, size_mb: int, tenant_id: str) -> None:
    target_bytes = size_mb * 1024 * 1024
    settings = get_settings()

    print(f"== generating {count} PDF(s), {size_mb} MB each ==")
    pdfs = [generate_pdf(target_bytes) for _ in range(count)]
    sizes_mb = [len(b) / 1024 / 1024 for b in pdfs]
    total_mb = sum(sizes_mb)
    print(f"   actual sizes (MB): {[round(s, 2) for s in sizes_mb]} (total {total_mb:.2f})")

    async with pool_lifecycle(settings.database_url) as pool:
        # Warm up the embedder (first call downloads / loads the model)
        # so the warm timings are what CI gates on.
        warmup_chunks: list[float] = []  # noqa: F841 — placeholder for type clarity
        print("== warming embedder ==")
        warm_t = time.perf_counter()
        await build_embedder(settings).embed_passages(["warm-up"])  # type: ignore[no-untyped-call]
        print(f"   warm: {time.perf_counter() - warm_t:.2f}s")

        rows: list[dict[str, float]] = []
        total_start = time.perf_counter()
        for i, pdf in enumerate(pdfs):
            print(f"\n== ingest {i + 1}/{count} ({len(pdf) / 1024 / 1024:.2f} MB) ==")
            row = await run_one(pool, settings.database_url, tenant_id, pdf, i)
            rows.append(row)
            print(
                f"   parse+chunk+persist: {row['parse_chunk_persist_s']:.2f}s · "
                f"embed: {row['embed_s']:.2f}s · "
                f"chunks: {row['chunks']:.0f} · pages: {row['pages']:.0f}"
            )
        total_s = time.perf_counter() - total_start

        # Aggregate
        sum_parse = sum(r["parse_chunk_persist_s"] for r in rows)
        sum_embed = sum(r["embed_s"] for r in rows)
        sum_chunks = sum(r["chunks"] for r in rows)
        wall_per_mb = total_s / total_mb if total_mb else 0
        projected_500 = wall_per_mb * 500

        print("\n== summary ==")
        print(f"   total wall:        {total_s:.2f}s")
        print(f"   total MB:          {total_mb:.2f}")
        print(f"   sec/MB:            {wall_per_mb:.3f}")
        print(f"   projected 500 MB:  {projected_500:.0f}s ({projected_500 / 60:.1f} min)")
        print(f"   total chunks:      {sum_chunks:.0f}")
        print(f"   parse share:       {sum_parse / total_s:.1%}")
        print(f"   embed share:       {sum_embed / total_s:.1%}")
        budget_s = 10 * 60
        ok = projected_500 <= budget_s
        print(f"   gate (≤ {budget_s}s):    {'PASS' if ok else 'FAIL'}")


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="ingest-load-test")
    p.add_argument("--count", type=int, default=3, help="number of PDFs")
    p.add_argument("--size-mb", type=int, default=5, help="target size per PDF in MB")
    p.add_argument(
        "--tenant-id",
        default="11111111-1111-1111-1111-111111111111",
        help="tenant uuid for the synthetic uploads",
    )
    args = p.parse_args(argv)
    asyncio.run(main_async(args.count, args.size_mb, args.tenant_id))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
