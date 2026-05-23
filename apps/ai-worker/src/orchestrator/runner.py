"""Orchestrator runtime.

A run executes a list of steps in order. Each step is one agent invocation.
The step's idempotency key (``sha256(agent.name||version||canonical_input)``)
collapses retries: re-invoking with the same key returns the cached output.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
from datetime import datetime, timezone
from typing import Any, Iterable
from uuid import uuid4

from pydantic import ValidationError

JsonDict = dict[str, Any]

from ..agents.base import AgentRegistry, idempotency_key_for
from ..agents.contracts import (
    Run,
    RunState,
    Step,
    StepState,
)
from .store import RunStore


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class Orchestrator:
    """Drives a run from ``queued`` to ``succeeded`` / ``failed`` / ``dead_letter``."""

    def __init__(self, store: RunStore, registry: AgentRegistry) -> None:
        self._store = store
        self._registry = registry

    # ── lifecycle ───────────────────────────────────────────────────────────

    async def submit(
        self,
        *,
        kind: str,
        payload: JsonDict,
        steps: Iterable[StepSpec],
        tenant_id: str | None = None,
        user_id: str | None = None,
        max_attempts: int = 5,
    ) -> Run:
        """Create or fetch a run by its idempotency key."""
        idem = self._run_idempotency_key(kind, payload)
        existing = await self._store.get_by_idempotency_key(kind, idem)
        if existing is not None:
            return existing

        now = _now_iso()
        run = Run(
            id=str(uuid4()),
            tenant_id=tenant_id,
            user_id=user_id,
            kind=kind,
            state=RunState.queued,
            attempts=0,
            max_attempts=max_attempts,
            idempotency_key=idem,
            payload=payload,
            result=None,
            error=None,
            steps=[self._materialise_step(s) for s in steps],
            created_at=now,
            updated_at=now,
        )
        return await self._store.upsert(run)

    async def execute(self, run_id: str) -> Run:
        run = await self._store.get(run_id)
        if run is None:
            raise KeyError(run_id)

        if run.state in (RunState.succeeded, RunState.dead_letter):
            return run

        run.state = RunState.running
        run.attempts += 1
        await self._store.upsert(run)

        try:
            for step in run.steps:
                if step.state == StepState.succeeded:
                    continue
                await self._execute_step(run, step)
            run.result = self._compose_result(run)
            run.state = RunState.succeeded
            run.error = None
        except StepFailure as exc:
            run.error = exc.message
            if run.attempts >= run.max_attempts:
                run.state = RunState.dead_letter
            else:
                run.state = RunState.failed
        except Exception as exc:  # pragma: no cover — last-resort safety net
            run.error = f"orchestrator: {exc!r}"
            run.state = RunState.dead_letter

        return await self._store.upsert(run)

    # ── step execution ──────────────────────────────────────────────────────

    async def _execute_step(self, run: Run, step: Step) -> None:
        agent = self._registry.get(step.agent_name)
        try:
            validated_input = agent.input_model.model_validate(step.input)
        except ValidationError as exc:
            step.state = StepState.failed
            step.error = f"input validation failed: {exc.errors()}"
            step.completed_at = _now_iso()
            raise StepFailure(step.error) from exc

        # Idempotency: if we already have an output cached for this step,
        # surface it without re-running the agent.
        cached_key = idempotency_key_for(agent, validated_input)
        if step.idempotency_key == cached_key and step.output is not None:
            step.state = StepState.succeeded
            return

        step.state = StepState.running
        step.attempts += 1
        step.started_at = _now_iso()
        step.idempotency_key = cached_key
        await self._store.upsert(run)

        try:
            result = await agent.run(validated_input)
        except Exception as exc:
            step.state = StepState.failed
            step.error = f"agent {agent.name}: {exc!r}"
            step.completed_at = _now_iso()
            raise StepFailure(step.error) from exc

        try:
            output_payload = result.model_dump(mode="json")
        except Exception as exc:
            step.state = StepState.failed
            step.error = f"agent {agent.name} output serialisation failed: {exc!r}"
            step.completed_at = _now_iso()
            raise StepFailure(step.error) from exc

        step.output = output_payload
        step.state = StepState.succeeded
        step.completed_at = _now_iso()
        step.error = None

    # ── helpers ─────────────────────────────────────────────────────────────

    def _materialise_step(self, spec: "StepSpec") -> Step:
        agent = self._registry.get(spec.agent_name)
        try:
            validated = agent.input_model.model_validate(spec.input)
        except ValidationError as exc:
            raise StepFailure(
                f"step '{spec.name}' input invalid for agent {agent.name}: {exc.errors()}"
            ) from exc
        return Step(
            name=spec.name,
            agent_name=agent.name,
            agent_version=agent.version,
            state=StepState.queued,
            attempts=0,
            idempotency_key=idempotency_key_for(agent, validated),
            input=validated.model_dump(mode="json"),
            output=None,
            error=None,
            started_at=None,
            completed_at=None,
        )

    def _run_idempotency_key(self, kind: str, payload: JsonDict) -> str:
        canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"))
        h = hashlib.sha256()
        h.update(kind.encode("utf-8"))
        h.update(b"|")
        h.update(canonical.encode("utf-8"))
        return h.hexdigest()

    def _compose_result(self, run: Run) -> JsonDict:
        """Default composer: surface the last step's output as the run result."""
        for step in reversed(run.steps):
            if step.output is not None:
                return step.output
        return {}


class StepSpec:
    """In-process spec for declaring a step before the run is materialised."""

    __slots__ = ("name", "agent_name", "input")

    def __init__(self, *, name: str, agent_name: str, input: JsonDict) -> None:
        self.name = name
        self.agent_name = agent_name
        self.input = input


class StepFailure(Exception):
    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


__all__ = ["Orchestrator", "StepFailure", "StepSpec"]


# Silence the unused-import linter when typing-only.
_ = asyncio
