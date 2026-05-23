"""Postgres-backed retrieval primitives.

Three classes that satisfy the Protocols from ``retriever.py``:

  * ``PgvectorDenseRetriever`` — ANN over ``Chunk.embedding`` via the HNSW
    cosine index installed by ``apps/api/prisma/sql/02_vector_indexes.sql``.
  * ``TsvectorSparseRetriever`` — BM25-style ranking over the ``Chunk.tsv``
    column populated by the trigger from ``03_search_indexes.sql``.
  * ``PostgresChunkResolver`` — single-fetch hydrator from chunk id to
    ``RetrievedChunk``.

All three share a connection pool. ``pgvector-psycopg`` registers the
``vector`` type adapter on every borrowed connection so lists pass straight
through to the driver.
"""

from __future__ import annotations

import logging
import re
from typing import Any

import numpy as np
from pgvector.psycopg import register_vector_async
from psycopg import AsyncConnection
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from .contracts import (
    Candidate,
    MetadataFilter,
    RetrievedChunk,
    RetrieverKind,
)

log = logging.getLogger(__name__)


# Token characters allowed in the OR-tsquery rewrite. Everything else is
# whitespace; this is what keeps the user query safe to inline into
# ``to_tsquery`` without being treated as operator syntax.
_TOKEN_RE = re.compile(r"[A-Za-z0-9_]+")
# Cheap stopword guard so a query like "what is x" doesn't blow up into
# ``what | is | x`` and ts_rank gives ties on every chunk.
_STOPWORDS = {
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "of", "to", "in", "on", "at", "by", "for", "with", "from", "as",
    "and", "or", "but", "if", "then", "than", "so", "do", "does", "did",
    "this", "that", "these", "those", "i", "you", "we", "they", "it",
    "what", "which", "who", "whom", "whose", "when", "where", "why", "how",
    "me", "my", "your", "our", "their", "tell", "about", "please",
}


def _build_or_tsquery(query: str) -> str:
    """Convert ``"Tell me about the DJI Matrice 4"`` → ``"DJI | Matrice | 4"``.

    ts_rank_cd still rewards chunks that match more terms because their
    rank density is higher, so OR-of-tokens degrades gracefully to roughly
    BM25 semantics for short queries.
    """
    tokens = [
        t for t in _TOKEN_RE.findall(query)
        if t.lower() not in _STOPWORDS and len(t) >= 2
    ]
    if not tokens:
        return ""
    return " | ".join(tokens)


class _PoolHolder:
    """Shared connection management for the three retrieval backends."""

    def __init__(self, dsn: str, *, min_size: int = 1, max_size: int = 4) -> None:
        self._dsn = dsn
        self._min_size = min_size
        self._max_size = max_size
        self._pool: AsyncConnectionPool | None = None

    async def pool(self) -> AsyncConnectionPool:
        if self._pool is None:
            pool = AsyncConnectionPool(
                self._dsn,
                min_size=self._min_size,
                max_size=self._max_size,
                open=False,
                # Register vector adapter on every connection borrowed.
                configure=_configure_connection,
            )
            await pool.open()
            self._pool = pool
        return self._pool

    async def aclose(self) -> None:
        if self._pool is not None:
            await self._pool.close()
            self._pool = None


async def _configure_connection(conn: AsyncConnection) -> None:
    await register_vector_async(conn)


# ─────────────────────────────────────────────────────────────────────────────
# Dense
# ─────────────────────────────────────────────────────────────────────────────


class PgvectorDenseRetriever:
    """ANN over ``Chunk.embedding`` (cosine, HNSW). Per-tenant isolation is
    enforced at the SQL layer via the ``Document → Tenant`` join."""

    def __init__(self, pool: _PoolHolder) -> None:
        self._pool = pool

    async def search(
        self,
        *,
        embedding: list[float],
        tenant_id: str,
        course_id: str | None,
        folder_id: str | None,
        k: int,
        metadata_filter: MetadataFilter | None,
        chapters: list[int] | None = None,
    ) -> list[Candidate]:
        pool = await self._pool.pool()
        # ``vector_cosine_ops`` makes ``<=>`` the cosine distance; we sort
        # ascending and convert to a [0, 1] similarity score for the Candidate.
        sql = """
            SELECT c.id AS chunk_id,
                   c.embedding <=> %(embedding)s AS cosine_distance
              FROM "Chunk" c
              JOIN "DocumentVersion" v ON v.id = c."documentVersionId"
              JOIN "Document"        d ON d.id = v."documentId"
             WHERE c.embedding IS NOT NULL
               AND d."tenantId" = %(tenant_id)s
               AND (%(course_id)s::uuid IS NULL OR d."courseId" = %(course_id)s::uuid)
               AND (%(folder_id)s::uuid IS NULL OR d."folderId" = %(folder_id)s::uuid)
               AND d."deletedAt" IS NULL
               AND (
                 %(chapters)s::int[] IS NULL
                 OR (c.meta->>'chapter')::int = ANY(%(chapters)s::int[])
               )
          ORDER BY c.embedding <=> %(embedding)s
             LIMIT %(k)s
        """
        # pgvector's psycopg adapter handles ``np.ndarray`` directly; raw
        # Python lists fall through to psycopg's default float[] adapter,
        # which doesn't match the ``vector`` operator.
        embedding_arr = np.asarray(embedding, dtype=np.float32)
        async with pool.connection() as conn:
            await register_vector_async(conn)
            async with conn.cursor(row_factory=dict_row) as cur:
                await cur.execute(
                    sql,
                    {
                        "embedding": embedding_arr,
                        "tenant_id": tenant_id,
                        "course_id": course_id,
                        "folder_id": folder_id,
                        "chapters": chapters if chapters else None,
                        "k": k,
                    },
                )
                rows = await cur.fetchall()
        candidates: list[Candidate] = []
        for rank, row in enumerate(rows):
            distance = float(row["cosine_distance"])
            # Cosine distance in [0, 2]; map to similarity in [0, 1].
            similarity = max(0.0, min(1.0, 1.0 - distance / 2.0))
            candidates.append(
                Candidate(
                    chunk_id=str(row["chunk_id"]),
                    rank=rank,
                    score=similarity,
                    kind=RetrieverKind.dense,
                )
            )
        return candidates


# ─────────────────────────────────────────────────────────────────────────────
# Sparse
# ─────────────────────────────────────────────────────────────────────────────


class TsvectorSparseRetriever:
    """BM25-style ranking via ``ts_rank_cd`` over ``Chunk.tsv``. The trigger
    from ``03_search_indexes.sql`` keeps the column up to date with the
    chunk content."""

    def __init__(self, pool: _PoolHolder) -> None:
        self._pool = pool

    async def search(
        self,
        *,
        query: str,
        tenant_id: str,
        course_id: str | None,
        folder_id: str | None,
        k: int,
        metadata_filter: MetadataFilter | None,
        chapters: list[int] | None = None,
    ) -> list[Candidate]:
        if not query.strip():
            return []
        pool = await self._pool.pool()
        # ``websearch_to_tsquery`` ANDs every token; with the BGE-M3 dense
        # path stubbed out, that strands long natural-language queries with
        # zero results because no chunk contains every word. Rewrite as an
        # OR-of-tokens so we degrade gracefully — chunks that match more
        # terms still rank higher via ``ts_rank_cd``.
        sql = """
            WITH parsed AS (
              SELECT to_tsquery('english', %(or_query)s) AS q
            )
            SELECT c.id AS chunk_id,
                   ts_rank_cd(c.tsv, parsed.q) AS rank_score
              FROM "Chunk" c
              JOIN "DocumentVersion" v ON v.id = c."documentVersionId"
              JOIN "Document"        d ON d.id = v."documentId",
                   parsed
             WHERE c.tsv @@ parsed.q
               AND d."tenantId" = %(tenant_id)s
               AND (%(course_id)s::uuid IS NULL OR d."courseId" = %(course_id)s::uuid)
               AND (%(folder_id)s::uuid IS NULL OR d."folderId" = %(folder_id)s::uuid)
               AND d."deletedAt" IS NULL
               AND (
                 %(chapters)s::int[] IS NULL
                 OR (c.meta->>'chapter')::int = ANY(%(chapters)s::int[])
               )
          ORDER BY rank_score DESC
             LIMIT %(k)s
        """
        or_query = _build_or_tsquery(query)
        if not or_query:
            return []
        async with pool.connection() as conn:
            async with conn.cursor(row_factory=dict_row) as cur:
                await cur.execute(
                    sql,
                    {
                        "or_query": or_query,
                        "tenant_id": tenant_id,
                        "course_id": course_id,
                        "folder_id": folder_id,
                        "chapters": chapters if chapters else None,
                        "k": k,
                    },
                )
                rows = await cur.fetchall()
        max_score = max((float(r["rank_score"]) for r in rows), default=1.0)
        if max_score <= 0.0:
            max_score = 1.0
        candidates: list[Candidate] = []
        for rank, row in enumerate(rows):
            normalised = float(row["rank_score"]) / max_score
            candidates.append(
                Candidate(
                    chunk_id=str(row["chunk_id"]),
                    rank=rank,
                    score=max(0.0, min(1.0, normalised)),
                    kind=RetrieverKind.sparse,
                )
            )
        return candidates


# ─────────────────────────────────────────────────────────────────────────────
# Chunk resolver
# ─────────────────────────────────────────────────────────────────────────────


class PostgresChunkResolver:
    """Hydrates fused chunk ids into full ``RetrievedChunk`` rows in one
    round trip. Preserves the input order so the reranker sees the fused
    ranking on top."""

    def __init__(self, pool: _PoolHolder) -> None:
        self._pool = pool

    async def hydrate(self, chunk_ids: list[str]) -> list[RetrievedChunk]:
        if not chunk_ids:
            return []
        pool = await self._pool.pool()
        sql = """
            SELECT c.id, c.ordinal, c.modality::text AS modality,
                   c.page, c.slide, c.cell,
                   c."charStart", c."charEnd", c.content, c.meta,
                   v."documentId" AS document_id, v.id AS version_id
              FROM "Chunk" c
              JOIN "DocumentVersion" v ON v.id = c."documentVersionId"
             WHERE c.id = ANY(%(ids)s::uuid[])
        """
        async with pool.connection() as conn:
            async with conn.cursor(row_factory=dict_row) as cur:
                await cur.execute(sql, {"ids": chunk_ids})
                rows = await cur.fetchall()
        by_id = {str(row["id"]): row for row in rows}
        out: list[RetrievedChunk] = []
        for chunk_id in chunk_ids:
            row = by_id.get(chunk_id)
            if row is None:
                continue
            meta = row.get("meta") or {}
            heading_path = meta.get("heading_path") if isinstance(meta, dict) else None
            out.append(
                RetrievedChunk(
                    chunk_id=str(row["id"]),
                    doc_id=str(row["document_id"]),
                    version_id=str(row["version_id"]),
                    page=row["page"],
                    slide=row["slide"],
                    cell=row["cell"],
                    char_start=int(row["charStart"]),
                    char_end=int(row["charEnd"]),
                    score=0.0,  # filled by reranker; orchestrator overwrites
                    content=row["content"],
                    modality=str(row["modality"]),
                    heading_path=list(heading_path) if isinstance(heading_path, list) else [],
                )
            )
        return out


# ─────────────────────────────────────────────────────────────────────────────
# Helper factory
# ─────────────────────────────────────────────────────────────────────────────


def build_postgres_backends(
    dsn: str,
) -> tuple[
    PgvectorDenseRetriever,
    TsvectorSparseRetriever,
    PostgresChunkResolver,
    _PoolHolder,
]:
    """One pool, three backends. Returns the pool holder too so the caller can
    ``await holder.aclose()`` at shutdown."""
    holder = _PoolHolder(dsn)
    return (
        PgvectorDenseRetriever(holder),
        TsvectorSparseRetriever(holder),
        PostgresChunkResolver(holder),
        holder,
    )


# Re-export for downstream typing convenience.
__all__ = [
    "PgvectorDenseRetriever",
    "PostgresChunkResolver",
    "TsvectorSparseRetriever",
    "build_postgres_backends",
]


# Silence the unused-import linter when the pool holder is only used internally.
_ = Any
