"""PostgresSemanticCache — integration test against the dev database.

Skipped when Postgres is unreachable so CI without a database passes.
"""

from __future__ import annotations

import os

import psycopg
import pytest
from psycopg_pool import AsyncConnectionPool

from src.agents.contracts import Citation
from src.cache import PostgresSemanticCache
from src.rag.embedder import StubEmbedder

DSN = os.environ.get(
    "DATABASE_URL",
    "postgresql://studyforge:studyforge@localhost:5432/studyforge",
)


async def _postgres_reachable() -> bool:
    try:
        async with await psycopg.AsyncConnection.connect(DSN, connect_timeout=2):
            return True
    except Exception:
        return False


pytestmark = pytest.mark.asyncio


@pytest.fixture
async def pool():
    if not await _postgres_reachable():
        pytest.skip("postgres unreachable; skipping cache integration")
    # Provision a tenant the rows can reference.
    async with await psycopg.AsyncConnection.connect(DSN) as conn, conn.cursor() as cur:
        await cur.execute(
            'INSERT INTO "Tenant" (id, name, slug, "updatedAt") '
            "VALUES (%s, 'CacheSmoke', %s, now()) ON CONFLICT (id) DO NOTHING",
            ("aaaaaaaa-0000-0000-0000-000000000001", "cache-smoke"),
        )
        await conn.commit()

    p = AsyncConnectionPool(DSN, min_size=1, max_size=2, open=False)
    await p.open()
    yield p
    # Clean cache rows for the smoke tenant.
    async with p.connection() as conn, conn.cursor() as cur:
        await cur.execute(
            'DELETE FROM "CachedResponse" WHERE "tenantId" = %s::uuid',
            ("aaaaaaaa-0000-0000-0000-000000000001",),
        )
        await conn.commit()
    await p.close()


def _citation() -> Citation:
    return Citation(
        chunk_id="c1",
        doc_id="d1",
        version_id="v1",
        page=12,
        slide=None,
        cell=None,
        char_start=0,
        char_end=100,
        score=0.9,
    )


async def test_postgres_cache_round_trips_a_response(pool: AsyncConnectionPool) -> None:
    cache = PostgresSemanticCache(pool=pool, embedder=StubEmbedder())
    await cache.store(
        query="What is gradient descent?",
        tenant_id="aaaaaaaa-0000-0000-0000-000000000001",
        course_id=None,
        chunk_set_hash="postgres-hash-1",
        response="Gradient descent answer.",
        citations=[_citation()],
        freshness_sec=120,
    )
    hit = await cache.lookup(
        query="What is gradient descent?",
        tenant_id="aaaaaaaa-0000-0000-0000-000000000001",
        course_id=None,
        chunk_set_hash="postgres-hash-1",
    )
    assert hit is not None
    assert hit.response == "Gradient descent answer."
    assert hit.similarity > 0.99
    assert hit.hits == 1
    assert hit.citations[0].chunk_id == "c1"


async def test_postgres_cache_isolates_by_tenant(pool: AsyncConnectionPool) -> None:
    cache = PostgresSemanticCache(pool=pool, embedder=StubEmbedder())
    await cache.store(
        query="Cross-tenant probe.",
        tenant_id="aaaaaaaa-0000-0000-0000-000000000001",
        course_id=None,
        chunk_set_hash="postgres-hash-iso",
        response="leak-detector",
        citations=[_citation()],
    )
    # Same query, different tenant → no hit even though the row exists.
    assert await cache.lookup(
        query="Cross-tenant probe.",
        tenant_id="bbbbbbbb-0000-0000-0000-000000000002",
        course_id=None,
        chunk_set_hash="postgres-hash-iso",
    ) is None


async def test_postgres_cache_increments_hits_atomically(
    pool: AsyncConnectionPool,
) -> None:
    cache = PostgresSemanticCache(pool=pool, embedder=StubEmbedder())
    await cache.store(
        query="Hit counter check.",
        tenant_id="aaaaaaaa-0000-0000-0000-000000000001",
        course_id=None,
        chunk_set_hash="postgres-hash-hits",
        response="reply",
        citations=[_citation()],
    )
    first = await cache.lookup(
        query="Hit counter check.",
        tenant_id="aaaaaaaa-0000-0000-0000-000000000001",
        course_id=None,
        chunk_set_hash="postgres-hash-hits",
    )
    second = await cache.lookup(
        query="Hit counter check.",
        tenant_id="aaaaaaaa-0000-0000-0000-000000000001",
        course_id=None,
        chunk_set_hash="postgres-hash-hits",
    )
    assert first is not None and second is not None
    assert first.hits == 1
    assert second.hits == 2
