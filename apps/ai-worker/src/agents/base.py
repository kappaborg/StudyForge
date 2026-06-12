"""Agent protocol + registry.

An agent is a stateless coroutine with a typed input and output. The registry
maps stable ``name`` strings (matching prompt ids like ``tutor.answer.v1``) to
agent instances so the orchestrator can resolve them by string at run time.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any, Generic, Protocol, TypeVar

from pydantic import BaseModel

I = TypeVar("I", bound=BaseModel)
O = TypeVar("O", bound=BaseModel)

# Convenience alias for places where the concrete agent type doesn't matter
# (the registry stores them all behind the same boundary).
AnyAgent = "Agent[Any, Any]"


class Agent(Protocol, Generic[I, O]):
    """Every agent implements this."""

    name: str
    """Stable id, e.g. ``tutor.answer.v1``. Must match a prompt id in the
    router prompt registry when the agent uses an LLM."""

    version: str
    """Semver of the agent implementation (independent of prompt version)."""

    input_model: type[I]
    output_model: type[O]

    async def run(self, payload: I) -> O:
        """Execute the agent. Raises on validation failure; raising on logic
        failure is allowed (orchestrator retries with backoff)."""
        ...


def idempotency_key_for(agent: Agent[Any, Any], payload: BaseModel) -> str:
    """Stable per-step idempotency key. Two invocations with the same agent +
    version + input produce the same key; the orchestrator collapses them.
    """
    canonical = json.dumps(payload.model_dump(mode="json"), sort_keys=True, separators=(",", ":"))
    digest = hashlib.sha256()
    digest.update(agent.name.encode("utf-8"))
    digest.update(b"|")
    digest.update(agent.version.encode("utf-8"))
    digest.update(b"|")
    digest.update(canonical.encode("utf-8"))
    return digest.hexdigest()


class AgentRegistry:
    """Resolves agent name → instance. The orchestrator never imports agent
    modules directly; it asks the registry."""

    def __init__(self) -> None:
        self._agents: dict[str, Agent[Any, Any]] = {}

    def register(self, agent: Agent[Any, Any]) -> None:
        if agent.name in self._agents:
            existing = self._agents[agent.name]
            if existing.version == agent.version:
                # Re-registering the same version is a no-op (helps with
                # hot-reload during development).
                return
            raise ValueError(
                f"agent '{agent.name}' already registered with version "
                f"'{existing.version}'; cannot replace with '{agent.version}'"
            )
        self._agents[agent.name] = agent

    def get(self, name: str) -> Agent[Any, Any]:
        try:
            return self._agents[name]
        except KeyError as exc:
            raise KeyError(f"agent not registered: {name!r}") from exc

    def names(self) -> list[str]:
        return sorted(self._agents.keys())


registry = AgentRegistry()
