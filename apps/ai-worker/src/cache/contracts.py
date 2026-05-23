"""Semantic cache contracts."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from ..agents.contracts import Citation


@dataclass(frozen=True)
class CacheHit:
    """A successful cache lookup. ``similarity`` is the cosine similarity
    between the lookup query and the stored query, in [0, 1]."""

    response: str
    citations: list[Citation]
    similarity: float
    age_sec: int
    hits: int
    """The new hit count after this lookup (incremented by the implementation)."""


class SemanticCache(Protocol):
    """Lookup-then-store contract. Implementations handle embedding the query
    internally so callers don't need an Embedder dep."""

    async def lookup(
        self,
        *,
        query: str,
        tenant_id: str,
        course_id: str | None,
        chunk_set_hash: str,
        similarity_threshold: float = 0.92,
    ) -> CacheHit | None: ...

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
    ) -> None: ...
