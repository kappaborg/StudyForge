"""End-to-end ingest smoke test against the live dev Postgres.

Synthesises a small PDF, runs it through the pipeline + PostgresIngestStore,
and prints the resulting row counts so we can visually confirm the
Document / DocumentVersion / Chunk tables were written.

Run from the repo root:

    cd apps/ai-worker
    uv run python scripts/ingest_smoke.py
"""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

import fitz

# Make ``src.*`` importable when run directly.
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.ingest import IngestRequest, PostgresIngestStore, ingest_document  # noqa: E402


def _build_pdf() -> bytes:
    doc = fitz.open()
    for body in [
        "Linear regression fits a line to data.\n"
        "The line is found by minimizing squared residuals.",
        "Gradient descent iteratively moves against the gradient.\n"
        "The learning rate scales each step.",
    ]:
        page = doc.new_page()
        page.insert_text((72, 72), body, fontsize=11)
    out = doc.tobytes()
    doc.close()
    return out


async def _ensure_upload_batch(dsn: str, *, tenant_id: str, batch_id: str) -> None:
    """Provision the minimum referenced rows so FKs are satisfied."""
    import psycopg

    async with await psycopg.AsyncConnection.connect(dsn) as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO "Tenant" (id, name, slug, "updatedAt")
                VALUES (%s, 'Smoke', 'smoke-tenant', now())
                ON CONFLICT (id) DO NOTHING
                """,
                (tenant_id,),
            )
            await cur.execute(
                """
                INSERT INTO "User" (id, "tenantId", email, "updatedAt")
                VALUES (%s, %s, 'smoke@studyforge.local', now())
                ON CONFLICT (id) DO NOTHING
                """,
                ("99999999-9999-9999-9999-999999999999", tenant_id),
            )
            await cur.execute(
                """
                INSERT INTO "UploadBatch" (id, "tenantId", "userId", state,
                  "bundleSha256", "sizeBytes", "s3Key", "safetyFlags", "updatedAt")
                VALUES (%s, %s, %s, 'uploaded', %s, %s, %s, ARRAY[]::text[], now())
                ON CONFLICT (id) DO NOTHING
                """,
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
    tenant_id = "55555555-5555-5555-5555-555555555555"
    batch_id = "66666666-6666-6666-6666-666666666666"

    await _ensure_upload_batch(dsn, tenant_id=tenant_id, batch_id=batch_id)

    store = PostgresIngestStore(dsn)
    pdf = _build_pdf()
    try:
        result = await ingest_document(
            IngestRequest(
                tenant_id=tenant_id,
                course_id=None,
                upload_batch_id=batch_id,
                mime="application/pdf",
                original_filename="smoke.pdf",
                s3_key="smoke/smoke.pdf",
                bytes=pdf,
            ),
            store,
        )
        print(f"document_id          {result.document_id}")
        print(f"document_version_id  {result.document_version_id}")
        print(f"page_count           {result.page_count}")
        print(f"chunk_count          {result.chunk_count}")
        print(f"bytes_sha256         {result.bytes_sha256}")
        print(f"content_sha256       {result.content_sha256}")
        print(f"safety_flags         {[f.value for f in result.safety_flags]}")
    finally:
        await store.aclose()
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
