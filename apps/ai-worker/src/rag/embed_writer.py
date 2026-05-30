"""Embedding writer.

Finds chunks whose ``embedding`` column is NULL (left there by the ingest
pipeline) and fills them by calling the embedder. Runs in batches so we never
load the entire chunk table into memory at once.

Idempotent: re-running over a fully-embedded corpus is a no-op (the WHERE
clause filters NULL rows).
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass

import numpy as np
from pgvector.psycopg import register_vector_async
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from .retriever import Embedder

log = logging.getLogger(__name__)

# Embedding batch size dominates peak worker memory: each batch keeps
# the input text array, an intermediate tensor stack, and the output
# vectors in RAM simultaneously. 32 (fastembed's library default) blew
# the 512 MB Render free-tier worker on multi-PPTX ingest. 8 keeps the
# peak around 250–300 MB while the same total throughput holds (4×
# the batches, each ~4× faster, same wall-clock).
DEFAULT_BATCH_SIZE = int(os.environ.get("EMBED_BATCH_SIZE", "8"))


@dataclass(frozen=True)
class EmbedJobResult:
    chunks_embedded: int
    batches: int


async def embed_pending_chunks(
    *,
    pool: AsyncConnectionPool,
    embedder: Embedder,
    course_id: str | None = None,
    document_version_id: str | None = None,
    batch_size: int = DEFAULT_BATCH_SIZE,
    max_chunks: int | None = None,
) -> EmbedJobResult:
    """Embed all chunks where ``embedding IS NULL``.

    Filters by ``course_id`` (via Document join) and / or ``document_version_id``
    when provided. ``max_chunks`` caps the total written in this invocation
    (useful for budget-aware runs).
    """
    total_written = 0
    batch_count = 0

    while True:
        if max_chunks is not None and total_written >= max_chunks:
            break
        budget = batch_size
        if max_chunks is not None:
            budget = min(budget, max_chunks - total_written)
        if budget <= 0:
            break

        async with pool.connection() as conn:
            await register_vector_async(conn)
            async with conn.cursor(row_factory=dict_row) as cur:
                await cur.execute(
                    _pending_query(course_id, document_version_id),
                    _pending_params(course_id, document_version_id, budget),
                )
                rows = await cur.fetchall()
                if not rows:
                    break

                ids = [str(r["id"]) for r in rows]
                texts = [r["content"] for r in rows]
                vectors = await embedder.embed_passages(texts)

                if len(vectors) != len(ids):
                    raise RuntimeError(
                        f"embedder returned {len(vectors)} vectors for "
                        f"{len(ids)} chunks"
                    )

                async with conn.transaction():
                    for chunk_id, vector in zip(ids, vectors, strict=True):
                        await cur.execute(
                            'UPDATE "Chunk" SET embedding = %s WHERE id = %s::uuid',
                            (np.asarray(vector, dtype=np.float32), chunk_id),
                        )

                total_written += len(ids)
                batch_count += 1

        if len(rows) < budget:
            # Last partial batch — nothing else pending.
            break

    log.info(
        "embed_writer: embedded %s chunks across %s batch(es)",
        total_written,
        batch_count,
    )
    return EmbedJobResult(chunks_embedded=total_written, batches=batch_count)


def _pending_query(course_id: str | None, version_id: str | None) -> str:
    filters = ['c.embedding IS NULL', 'd."deletedAt" IS NULL']
    if course_id is not None:
        filters.append('d."courseId" = %(course_id)s::uuid')
    if version_id is not None:
        filters.append('v.id = %(version_id)s::uuid')
    where = " AND ".join(filters)
    return f"""
        SELECT c.id, c.content
          FROM "Chunk" c
          JOIN "DocumentVersion" v ON v.id = c."documentVersionId"
          JOIN "Document"        d ON d.id = v."documentId"
         WHERE {where}
      ORDER BY c."createdAt", c.id
         LIMIT %(limit)s
    """


def _pending_params(
    course_id: str | None,
    version_id: str | None,
    limit: int,
) -> dict[str, object]:
    params: dict[str, object] = {"limit": limit}
    if course_id is not None:
        params["course_id"] = course_id
    if version_id is not None:
        params["version_id"] = version_id
    return params
