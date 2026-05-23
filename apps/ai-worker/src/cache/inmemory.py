"""In-memory semantic cache.

Used by tests and the dev loop when Postgres isn't reachable. Linear scan
over stored entries — acceptable because tests touch dozens of rows, not
thousands. Production paths use ``PostgresSemanticCache`` (HNSW over
pgvector).
"""

from __future__ import annotations

import math
import time
from dataclasses import dataclass, field

from ..agents.contracts import Citation
from ..rag.retriever import Embedder
from .contracts import CacheHit, SemanticCache


@dataclass
class _Entry:
    tenant_id: str
    course_id: str | None
    chunk_set_hash: str
    query_embedding: list[float]
    response: str
    citations: list[Citation]
    freshness_sec: int
    created_at: float
    hits: int = 0

    @property
    def expires_at(self) -> float:
        return self.created_at + self.freshness_sec


@dataclass
class InMemorySemanticCache(SemanticCache):
    embedder: Embedder
    entries: list[_Entry] = field(default_factory=list)
    """Linear-scan list. Cheap for tests, never used in production."""

    async def lookup(
        self,
        *,
        query: str,
        tenant_id: str,
        course_id: str | None,
        chunk_set_hash: str,
        similarity_threshold: float = 0.92,
    ) -> CacheHit | None:
        now = time.time()
        query_vec = await self.embedder.embed_query(query)

        best: tuple[float, _Entry] | None = None
        for entry in self.entries:
            if entry.tenant_id != tenant_id:
                continue
            if entry.course_id != course_id:
                continue
            if entry.chunk_set_hash != chunk_set_hash:
                continue
            if entry.expires_at <= now:
                continue
            similarity = _cosine(query_vec, entry.query_embedding)
            if similarity < similarity_threshold:
                continue
            if best is None or similarity > best[0]:
                best = (similarity, entry)

        if best is None:
            return None
        similarity, entry = best
        entry.hits += 1
        return CacheHit(
            response=entry.response,
            citations=list(entry.citations),
            similarity=similarity,
            age_sec=int(now - entry.created_at),
            hits=entry.hits,
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
        query_vec = await self.embedder.embed_query(query)
        self.entries.append(
            _Entry(
                tenant_id=tenant_id,
                course_id=course_id,
                chunk_set_hash=chunk_set_hash,
                query_embedding=query_vec,
                response=response,
                citations=list(citations),
                freshness_sec=freshness_sec,
                created_at=time.time(),
            )
        )


def _cosine(a: list[float], b: list[float]) -> float:
    if len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b, strict=True))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0.0 or nb == 0.0:
        return 0.0
    sim = dot / (na * nb)
    return max(0.0, min(1.0, sim))
