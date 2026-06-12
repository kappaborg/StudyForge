"""Metering decorator for ``LLMProvider`` adapters.

Wraps any provider so every successful ``complete()`` / final streaming
chunk increments the ``src.metrics`` Prometheus counters. This is the
single point of instrumentation — once the registry wraps an adapter
here, every consumer (tutor, flashcard, quiz, roadmap, semantic,
diagram, presentation) contributes to the platform-cost dashboard
without per-agent metering boilerplate.

Design notes
  * The wrapper preserves the ``LLMProvider`` protocol's class
    attributes (``id``, ``supports_prompt_cache``, ``supports_streaming``,
    ``context_window_tokens``) so callers that read those before issuing
    a call (the cost router does this) see the inner adapter's values.
  * Streaming usage lands on the terminal chunk (``done=True``) per the
    contract; the wrapper meters there.
  * Errors propagate untouched — failed calls don't count toward token
    spend (they didn't consume the provider's quota either).
  * The wrapped provider owns the inner's lifecycle. ``aclose()``
    forwards.
"""

from __future__ import annotations

from collections.abc import AsyncIterator

from ..metrics import record_provider_call
from .contracts import LLMProvider, LLMRequest, LLMResponse, LLMStreamChunk


class MeteredProvider:
    """Pass-through wrapper that meters every successful call."""

    def __init__(self, inner: LLMProvider) -> None:
        self._inner = inner
        # Protocol surface — mirror the inner so type-narrowing callers
        # still see the right values.
        self.id = inner.id
        self.supports_prompt_cache = inner.supports_prompt_cache
        self.supports_streaming = inner.supports_streaming
        self.context_window_tokens = inner.context_window_tokens

    async def complete(self, req: LLMRequest) -> LLMResponse:
        response = await self._inner.complete(req)
        record_provider_call(
            response.provider_id,
            tokens_in=response.usage.tokens_in,
            tokens_out=response.usage.tokens_out,
            cached_in=response.usage.cached_tokens_in,
            cache_hit=response.usage.cache_hit,
        )
        return response

    def stream(self, req: LLMRequest) -> AsyncIterator[LLMStreamChunk]:
        return self._stream(req)

    async def _stream(self, req: LLMRequest) -> AsyncIterator[LLMStreamChunk]:
        async for chunk in self._inner.stream(req):
            if chunk.done and chunk.usage is not None:
                record_provider_call(
                    self.id,
                    tokens_in=chunk.usage.tokens_in,
                    tokens_out=chunk.usage.tokens_out,
                    cached_in=chunk.usage.cached_tokens_in,
                    cache_hit=chunk.usage.cache_hit,
                )
            yield chunk

    async def ping(self) -> dict[str, object]:
        return await self._inner.ping()

    async def aclose(self) -> None:
        close = getattr(self._inner, "aclose", None)
        if callable(close):
            await close()


__all__ = ["MeteredProvider"]
