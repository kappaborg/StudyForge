"""Semantic cache for grounded LLM responses.

Sits between agents and provider calls: when a query is semantically close to
a previously-answered question over the SAME chunk set, return the cached
response + citations instead of paying for another LLM call.

  query → embed → nearest cached row in (tenant, course, chunk_set_hash) →
                  cosine >= threshold AND not expired → cache hit

The cache is scoped by ``(tenant_id, course_id, chunk_set_hash)`` so that:
  * cross-tenant leakage is impossible (the ``tenant_id`` predicate is part of
    the SQL filter, not just application logic),
  * a corpus change (re-ingest, new ``DocumentVersion``) silently invalidates
    older entries — the chunk set hash differs, no rows match.

Two implementations:
  * ``InMemorySemanticCache`` — used by tests and the dev loop when Postgres
    isn't reachable.
  * ``PostgresSemanticCache`` — pgvector cosine over the ``CachedResponse``
    table from §3.
"""

from .contracts import (
    CacheHit as CacheHit,
)
from .contracts import (
    SemanticCache as SemanticCache,
)
from .inmemory import InMemorySemanticCache as InMemorySemanticCache
from .postgres import PostgresSemanticCache as PostgresSemanticCache
from .util import chunk_set_hash as chunk_set_hash
