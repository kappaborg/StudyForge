"""StudyForge AI agents.

Twelve specialised agents, each independently testable. Coordination happens in
``src.orchestrator``. Every agent ships a Pydantic input/output contract and a
``run`` coroutine. The router is the only path to LLM providers.
"""

from . import contracts as contracts
from .base import Agent as Agent, AgentRegistry as AgentRegistry, registry as registry
