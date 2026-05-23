"""Postgres semantic cache.

Backs the `CachedResponse` table from Deliverable 3:

  * ``queryEmbedding`` — pgvector(1024); HNSW cosine index installed by
    ``apps/api/prisma/sql/02_vector_indexes.sql``.
  * ``chunkSetHash`` — sha256 of the retrieved chunk ids at the time of the
    original answer. Corpus changes invalidate the row silently because the
    hash differs.
  * ``expiresAt`` — written as ``createdAt + freshnessSec``; the lookup
    predicate keeps stale rows from being returned even before a purge job
    runs.
  * ``hits`` — incremented atomically on every cache hit so dashboards can
    show real cache-effectiveness, not just write counts.

Tenant isolation is enforced both by the application's ``tenantId`` filter
and by RLS (every CachedResponse row carries a ``tenantId`` and the policy
from ``04_rls.sql`` filters on ``app.tenant_id``).
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass

import numpy as np
from pgvector.psycopg import register_vector_async
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import AsyncConnectionPool

from ..agents.contracts import Citation
from ..rag.retriever import Embedder
from .contracts import CacheHit, SemanticCache

log = logging.getLogger(__name__)


@dataclass
class PostgresSemanticCache(SemanticCache):
    """pgvector-backed semantic cache."""

    pool: AsyncConnectionPool
    embedder: Embedder

    async def lookup(
        self,
        *,
        query: str,
        tenant_id: str,
        course_id: str | None,
        chunk_set_hash: str,
        similarity_threshold: float = 0.92,
    ) -> CacheHit | None:
        query_vec = np.asarray(await self.embedder.embed_query(query), dtype=np.float32)

        sql = """
            SELECT id, response, "citationsJson",
                   1 - ("queryEmbedding" <=> %(embedding)s) AS similarity,
                   GREATEST(0, EXTRACT(EPOCH FROM (now() - "createdAt"))) AS age_sec,
                   hits
              FROM "CachedResponse"
             WHERE "tenantId" = %(tenant_id)s::uuid
               AND ("courseId" = %(course_id)s::uuid
                    OR ("courseId" IS NULL AND %(course_id)s::uuid IS NULL))
               AND "chunkSetHash" = %(chunk_set_hash)s
               AND "expiresAt" > now()
          ORDER BY "queryEmbedding" <=> %(embedding)s
             LIMIT 1
        """

        async with self.pool.connection() as conn:
            await register_vector_async(conn)
            async with conn.cursor(row_factory=dict_row) as cur:
                await cur.execute(
                    sql,
                    {
                        "embedding": query_vec,
                        "tenant_id": tenant_id,
                        "course_id": course_id,
                        "chunk_set_hash": chunk_set_hash,
                    },
                )
                row = await cur.fetchone()
                if row is None:
                    return None
                similarity = float(row["similarity"])
                if similarity < similarity_threshold:
                    return None
                # Atomic increment so concurrent lookups never lose a count.
                await cur.execute(
                    'UPDATE "CachedResponse" SET hits = hits + 1 WHERE id = %s::uuid RETURNING hits',
                    (str(row["id"]),),
                )
                new_hits_row = await cur.fetchone()
                new_hits = int(new_hits_row["hits"]) if new_hits_row else int(row["hits"]) + 1
                await conn.commit()

        citations_payload = row["citationsJson"]
        if isinstance(citations_payload, str):
            citations_payload = json.loads(citations_payload)
        citations = [Citation.model_validate(c) for c in (citations_payload or [])]
        return CacheHit(
            response=row["response"],
            citations=citations,
            similarity=similarity,
            age_sec=int(row["age_sec"]),
            hits=new_hits,
        )

    async def store(
        self,
        *,
        query: str,
        tenant_id: str,
        course_id: str | None,
        chunk_set_hash: str,
        response: str,
        citations: list[Citation],
        freshness_sec: int = 3600,
    ) -> None:
        query_vec = np.asarray(await self.embedder.embed_query(query), dtype=np.float32)
        citations_json = [c.model_dump(mode="json") for c in citations]

        sql = """
            INSERT INTO "CachedResponse" (
              id, "tenantId", "courseId", "queryEmbedding", "chunkSetHash",
              response, "citationsJson", "freshnessSec", "expiresAt"
            )
            VALUES (
              gen_random_uuid(), %(tenant_id)s::uuid, %(course_id)s::uuid,
              %(embedding)s, %(chunk_set_hash)s,
              %(response)s, %(citations_json)s, %(freshness_sec)s,
              now() + (%(freshness_sec)s || ' seconds')::interval
            )
        """
        async with self.pool.connection() as conn:
            await register_vector_async(conn)
            async with conn.cursor() as cur:
                await cur.execute(
                    sql,
                    {
                        "embedding": query_vec,
                        "tenant_id": tenant_id,
                        "course_id": course_id,
                        "chunk_set_hash": chunk_set_hash,
                        "response": response,
                        "citations_json": Jsonb(citations_json),
                        "freshness_sec": freshness_sec,
                    },
                )
                await conn.commit()
