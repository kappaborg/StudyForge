"""PostgresRunStore — integration test against the dev database.

Skipped when ``DATABASE_URL`` is unreachable so CI without a database passes.
When the docker compose stack is up, exercises the full lifecycle: upsert →
get → get_by_idempotency_key → list, plus the orchestrator end-to-end with
this store substituted for the in-memory one.
"""

from __future__ import annotations

import os
from uuid import uuid4

import psycopg
import pytest
from psycopg_pool import AsyncConnectionPool

from src.agents import AgentRegistry
from src.agents.tutor import TutorAgent
from src.agents.contracts import RunState, StepState
from src.orchestrator import Orchestrator, PostgresRunStore
from src.orchestrator.runner import StepSpec

DSN = os.environ.get(
    "DATABASE_URL",
    "postgresql://studyforge:studyforge@localhost:5432/studyforge",
)


async def _postgres_reachable() -> bool:
    try:
        async with await psycopg.AsyncConnection.connect(DSN, connect_timeout=2) as _conn:
            return True
    except Exception:
        return False


pytestmark = pytest.mark.asyncio


@pytest.fixture
async def pool():
    if not await _postgres_reachable():
        pytest.skip("postgres unreachable; skipping integration test")
    p = AsyncConnectionPool(DSN, min_size=1, max_size=2, open=False)
    await p.open()
    yield p
    await p.close()


@pytest.fixture
async def store(pool: AsyncConnectionPool):
    s = PostgresRunStore(pool)
    yield s
    # Best-effort cleanup of test rows.
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                'DELETE FROM "Job" WHERE kind = %s', ("tutor.answer.v1",)
            )


def _registry() -> AgentRegistry:
    reg = AgentRegistry()
    reg.register(TutorAgent())
    return reg


def _payload(query: str = "What is gradient descent?") -> dict:
    return {
        "session_id": str(uuid4()),
        "user_id": str(uuid4()),
        "query": query,
        "retrieved_chunks": [],
    }


async def test_postgres_store_round_trips_a_run(store: PostgresRunStore) -> None:
    orch = Orchestrator(store=store, registry=_registry())
    payload = _payload()
    run = await orch.submit(
        kind="tutor.answer.v1",
        payload=payload,
        steps=[StepSpec(name="answer", agent_name="tutor.answer.v1", input=payload)],
    )
    executed = await orch.execute(run.id)

    assert executed.state is RunState.succeeded
    assert executed.steps[0].state is StepState.succeeded

    fetched = await store.get(run.id)
    assert fetched is not None
    assert fetched.id == run.id
    assert fetched.state is RunState.succeeded
    assert fetched.result is not None
    assert fetched.result["refusal"] is True  # no chunks → typed refusal


async def test_postgres_store_lookup_by_idempotency_key(store: PostgresRunStore) -> None:
    orch = Orchestrator(store=store, registry=_registry())
    payload = _payload(query="idempotency-test")
    first = await orch.submit(
        kind="tutor.answer.v1",
        payload=payload,
        steps=[StepSpec(name="answer", agent_name="tutor.answer.v1", input=payload)],
    )
    second = await orch.submit(
        kind="tutor.answer.v1",
        payload=payload,
        steps=[StepSpec(name="answer", agent_name="tutor.answer.v1", input=payload)],
    )
    assert first.id == second.id

    fetched = await store.get_by_idempotency_key("tutor.answer.v1", first.idempotency_key)
    assert fetched is not None
    assert fetched.id == first.id


async def test_postgres_store_survives_store_recreation(
    pool: AsyncConnectionPool,
) -> None:
    """Simulates a worker restart — make a run with store #1, fetch it with
    store #2 sharing the same pool. The data is in Postgres, not memory."""
    store_a = PostgresRunStore(pool)
    orch = Orchestrator(store=store_a, registry=_registry())
    payload = _payload(query="durability-test")
    run = await orch.submit(
        kind="tutor.answer.v1",
        payload=payload,
        steps=[StepSpec(name="answer", agent_name="tutor.answer.v1", input=payload)],
    )
    await orch.execute(run.id)

    # New store instance — would lose all state if the underlying impl were
    # in-memory. With Postgres, the data is durable.
    store_b = PostgresRunStore(pool)
    fetched = await store_b.get(run.id)
    assert fetched is not None
    assert fetched.id == run.id
    assert fetched.state is RunState.succeeded
