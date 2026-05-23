"""End-to-end smoke: ingest a PDF, embed pending chunks, retrieve.

Pipeline:
  1. Build a synthetic PDF with two distinct topics.
  2. Run the ingest pipeline to persist Document + Chunks.
  3. Run ``embed_pending_chunks`` with the StubEmbedder.
  4. Build the Retriever (pgvector dense + tsvector sparse + identity rerank).
  5. Query for one of the topics; assert the matching chunk wins.

Run from the ai-worker directory:

    uv run python scripts/retrieve_smoke.py
"""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

import fitz
from psycopg_pool import AsyncConnectionPool

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.ingest import IngestRequest, PostgresIngestStore, ingest_document  # noqa: E402
from src.rag import (  # noqa: E402
    IdentityReranker,
    RetrievalRequest,
    Retriever,
    StubEmbedder,
    build_postgres_backends,
    embed_pending_chunks,
)


def _build_pdf() -> bytes:
    doc = fitz.open()
    for body in [
        # Two topically distinct pages so dense + sparse retrieval have
        # something to discriminate.
        "Linear regression fits a line to data by minimising squared residuals.",
        "Gradient descent is an iterative algorithm that moves against the loss gradient.",
    ]:
        page = doc.new_page()
        page.insert_text((72, 72), body, fontsize=11)
    out = doc.tobytes()
    doc.close()
    return out


async def _ensure_refs(dsn: str, *, tenant_id: str, batch_id: str) -> None:
    import psycopg

    async with await psycopg.AsyncConnection.connect(dsn) as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                'INSERT INTO "Tenant" (id, name, slug, "updatedAt")'
                " VALUES (%s, 'Smoke', %s, now()) ON CONFLICT (id) DO NOTHING",
                (tenant_id, f"smoke-{tenant_id[:8]}"),
            )
            await cur.execute(
                'INSERT INTO "User" (id, "tenantId", email, "updatedAt")'
                " VALUES (%s, %s, %s, now()) ON CONFLICT (id) DO NOTHING",
                (
                    "99999999-9999-9999-9999-999999999999",
                    tenant_id,
                    f"smoke-{tenant_id[:8]}@studyforge.local",
                ),
            )
            await cur.execute(
                'INSERT INTO "UploadBatch" (id, "tenantId", "userId", state,'
                ' "bundleSha256", "sizeBytes", "s3Key", "safetyFlags", "updatedAt")'
                " VALUES (%s, %s, %s, 'uploaded', %s, %s, %s, ARRAY[]::text[], now())"
                " ON CONFLICT (id) DO NOTHING",
                (
                    batch_id,
                    tenant_id,
                    "99999999-9999-9999-9999-999999999999",
                    "0" * 64,
                    1000,
                    "smoke/upload",
                ),
            )
            await conn.commit()


async def main() -> int:
    dsn = os.environ.get(
        "DATABASE_URL",
        "postgresql://studyforge:studyforge@localhost:5432/studyforge",
    )
    tenant_id = "77777777-7777-7777-7777-777777777777"
    batch_id = "88888888-8888-8888-8888-888888888888"
    await _ensure_refs(dsn, tenant_id=tenant_id, batch_id=batch_id)

    pdf = _build_pdf()
    ingest_store = PostgresIngestStore(dsn)
    try:
        ingest_result = await ingest_document(
            IngestRequest(
                tenant_id=tenant_id,
                course_id=None,
                upload_batch_id=batch_id,
                mime="application/pdf",
                original_filename="smoke.pdf",
                s3_key="smoke/smoke.pdf",
                bytes=pdf,
            ),
            ingest_store,
        )
    finally:
        await ingest_store.aclose()
    print(f"ingest: {ingest_result.chunk_count} chunks, {ingest_result.page_count} pages")

    # Embed.
    embedder = StubEmbedder()
    pool = AsyncConnectionPool(dsn, min_size=1, max_size=4, open=False)
    await pool.open()
    try:
        embed_result = await embed_pending_chunks(pool=pool, embedder=embedder)
    finally:
        await pool.close()
    print(
        f"embed: wrote {embed_result.chunks_embedded} vectors "
        f"across {embed_result.batches} batch(es)"
    )

    # Retrieve.
    dense, sparse, resolver, holder = build_postgres_backends(dsn)
    retriever = Retriever(
        embedder=embedder,
        dense=dense,
        sparse=sparse,
        reranker=IdentityReranker(),
        resolver=resolver,
    )
    try:
        # The query embedding == the chunk embedding because both pass through
        # StubEmbedder. The dense path should rank "gradient descent" first.
        result = await retriever.retrieve(
            RetrievalRequest(
                tenant_id=tenant_id,
                course_id=None,
                query="Gradient descent is an iterative algorithm that moves against the loss gradient.",
                k=2,
            )
        )
    finally:
        await holder.aclose()

    print("retrieved (in order):")
    for i, chunk in enumerate(result.chunks):
        print(f"  {i}. page={chunk.page} preview={chunk.content[:70]!r}")
    print(
        "telemetry: "
        f"dense={result.telemetry.dense_candidates} "
        f"sparse={result.telemetry.sparse_candidates} "
        f"fused={result.telemetry.fused_candidates} "
        f"reranked={result.telemetry.reranked_returned}"
    )

    if not result.chunks:
        print("FAIL: no chunks returned")
        return 1
    if "Gradient descent" not in result.chunks[0].content:
        print("FAIL: expected gradient-descent chunk to win, got:", result.chunks[0].content[:80])
        return 1
    print("OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
