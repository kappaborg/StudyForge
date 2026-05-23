"""Orchestrator state machine — idempotency + step replay."""

from __future__ import annotations

import pytest

from src.agents import AgentRegistry
from src.agents.tutor import TutorAgent
from src.agents.contracts import RunState, StepState
from src.orchestrator import InMemoryRunStore, Orchestrator
from src.orchestrator.runner import StepSpec


def _registry_with_tutor() -> AgentRegistry:
    reg = AgentRegistry()
    reg.register(TutorAgent())
    return reg


def _tutor_payload(query: str = "What is gradient descent?") -> dict:
    return {
        "session_id": "11111111-1111-1111-1111-111111111111",
        "user_id": "22222222-2222-2222-2222-222222222222",
        "query": query,
        "retrieved_chunks": [],
    }


@pytest.mark.asyncio
async def test_orchestrator_executes_single_step_run_to_success() -> None:
    store = InMemoryRunStore()
    orch = Orchestrator(store=store, registry=_registry_with_tutor())

    payload = _tutor_payload()
    run = await orch.submit(
        kind="tutor.answer.v1",
        payload=payload,
        steps=[StepSpec(name="answer", agent_name="tutor.answer.v1", input=payload)],
    )
    executed = await orch.execute(run.id)

    assert executed.state == RunState.succeeded
    assert executed.attempts == 1
    assert len(executed.steps) == 1
    assert executed.steps[0].state == StepState.succeeded
    # Tutor refuses (no chunks) — refusal IS a successful outcome at the
    # orchestrator level. Citation enforcement is the agent's job.
    assert executed.result is not None
    assert executed.result["refusal"] is True


@pytest.mark.asyncio
async def test_orchestrator_collapses_runs_with_same_idempotency_key() -> None:
    store = InMemoryRunStore()
    orch = Orchestrator(store=store, registry=_registry_with_tutor())

    payload = _tutor_payload()
    spec = StepSpec(name="answer", agent_name="tutor.answer.v1", input=payload)

    first = await orch.submit(kind="tutor.answer.v1", payload=payload, steps=[spec])
    second = await orch.submit(kind="tutor.answer.v1", payload=payload, steps=[spec])

    assert first.id == second.id


@pytest.mark.asyncio
async def test_orchestrator_reports_unknown_agent() -> None:
    store = InMemoryRunStore()
    orch = Orchestrator(store=store, registry=_registry_with_tutor())

    with pytest.raises(KeyError):
        await orch.submit(
            kind="not.an.agent",
            payload={},
            steps=[StepSpec(name="x", agent_name="not.an.agent", input={})],
        )
