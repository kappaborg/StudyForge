"""FastAPI routes for /v1/agents/runs.

Submission shape mirrors the orchestrator's ``submit`` method: a single agent
invocation per run is the common case for the gateway calling into the worker.
The single-step form is convenience; multi-step runs go through the same
endpoint with a different payload shape (planned for Phase 2).
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, ConfigDict

from ..agents.base import AgentRegistry
from ..agents.contracts import Run
from ..orchestrator import Orchestrator
from ..orchestrator.runner import StepSpec


class RunCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: str
    """Run kind, e.g. ``tutor.answer.v1``. Doubles as the agent name for
    single-step runs."""

    input: dict[str, Any]
    """Agent input. Must validate against the agent's input model."""

    tenant_id: str | None = None
    user_id: str | None = None


def build_router(orchestrator: Orchestrator, registry: AgentRegistry) -> APIRouter:
    router = APIRouter(prefix="/v1/agents", tags=["agents"])

    @router.post("/runs", status_code=status.HTTP_201_CREATED, response_model=Run)
    async def create_run(req: RunCreateRequest) -> Run:
        try:
            registry.get(req.kind)
        except KeyError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        run = await orchestrator.submit(
            kind=req.kind,
            payload=req.input,
            tenant_id=req.tenant_id,
            user_id=req.user_id,
            steps=[StepSpec(name=req.kind, agent_name=req.kind, input=req.input)],
        )
        return await orchestrator.execute(run.id)

    @router.get("/runs/{run_id}", response_model=Run)
    async def get_run(run_id: str) -> Run:
        run = await orchestrator._store.get(run_id)
        if run is None:
            raise HTTPException(status_code=404, detail="run not found")
        return run

    return router
