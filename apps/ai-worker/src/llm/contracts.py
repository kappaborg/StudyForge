"""Wire types + the ``LLMProvider`` protocol every adapter implements.

The shapes mirror the TypeScript types in ``packages/llm-router/src/types.ts``
so FE / gateway / worker stay in lockstep.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Literal, Protocol

from pydantic import BaseModel, ConfigDict, Field, NonNegativeInt

Role = Literal["system", "user", "assistant", "tool"]


class ChannelMessage(BaseModel):
    """Same shape as the channel-separated message produced by
    ``safety.prompt_builder``. The provider adapter is responsible for
    translating it into the provider's native format (system block vs role
    array, content parts vs strings, etc.)."""

    model_config = ConfigDict(extra="forbid")

    role: Role
    content: str


class LLMUsage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    tokens_in: NonNegativeInt = 0
    tokens_out: NonNegativeInt = 0
    # How many of ``tokens_in`` came from the provider's prompt cache.
    # 0 when not supported (Groq) or no hit; > 0 when Anthropic returns
    # ``cache_read_input_tokens`` or OpenAI returns
    # ``prompt_tokens_details.cached_tokens``.
    cached_tokens_in: NonNegativeInt = 0
    cache_hit: bool = False

    @property
    def cache_hit_ratio(self) -> float:
        """Fraction of input tokens served from cache. 0.0 when there were no
        input tokens, or when the provider doesn't report cache hits."""
        if self.tokens_in <= 0:
            return 0.0
        return min(1.0, self.cached_tokens_in / self.tokens_in)


class LLMRequest(BaseModel):
    """A single, provider-agnostic completion request."""

    model_config = ConfigDict(extra="forbid")

    model: str
    """Provider-specific model id (e.g. ``llama-3.3-70b-versatile`` for Groq)."""

    messages: list[ChannelMessage]
    max_output_tokens: NonNegativeInt = 1024
    temperature: float = Field(default=0.2, ge=0.0, le=2.0)
    stream: bool = False
    cache_prefix_boundary: int | None = None
    """When non-None, identifies the prefix that should be cached. Adapters
    translate this into the provider's native cache marker (Anthropic
    ``cache_control``, Gemini context-caching, OpenAI automatic)."""

    stop: list[str] | None = None
    user: str | None = None
    """Stable end-user identifier passed to providers for abuse correlation."""


class LLMStreamChunk(BaseModel):
    model_config = ConfigDict(extra="forbid")

    delta: str
    done: bool = False
    finish_reason: str | None = None
    usage: LLMUsage | None = None
    """Populated on the terminal chunk (``done = True``)."""


class LLMResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str
    finish_reason: str
    usage: LLMUsage
    model: str
    provider_id: str


class LLMProvider(Protocol):
    """Every adapter implements this. ``id`` matches the provider id used by
    the router (Deliverable 13.1) and the ``UsageEvent`` ledger."""

    id: str
    supports_prompt_cache: bool
    supports_streaming: bool
    context_window_tokens: int

    async def complete(self, req: LLMRequest) -> LLMResponse: ...

    def stream(self, req: LLMRequest) -> AsyncIterator[LLMStreamChunk]: ...

    async def ping(self) -> dict[str, object]:
        """Cheap reachability probe. Returns ``{"ok": bool, "latency_ms": int}``."""
        ...
