"""MeteredProvider — single point of Prometheus instrumentation.

The wrapper increments the same counters per-agent code would, but
without the boilerplate. Tests verify:
  * Successful complete() bumps PROMPT_CACHE_CHECK / USAGE_TOKENS.
  * cache_hit=True bumps PROMPT_CACHE_HIT.
  * Streaming meters only on the terminal usage chunk, not per-delta.
  * Failed calls don't count — the provider's quota wasn't consumed.
  * Protocol attributes pass through.
"""

from __future__ import annotations

from collections.abc import AsyncIterator

import pytest
from prometheus_client import generate_latest

from src.llm.contracts import (
    ChannelMessage,
    LLMProvider,
    LLMRequest,
    LLMResponse,
    LLMStreamChunk,
    LLMUsage,
)
from src.llm.metered import MeteredProvider
from src.metrics import (
    PROMPT_CACHE_CHECK,
    PROMPT_CACHE_HIT,
    USAGE_TOKENS,
)


class _FakeProvider(LLMProvider):
    id = "fake"
    supports_prompt_cache = True
    supports_streaming = True
    context_window_tokens = 8000

    def __init__(
        self,
        *,
        complete_response: LLMResponse | None = None,
        raise_on_complete: bool = False,
    ) -> None:
        self._complete_response = complete_response
        self._raise_on_complete = raise_on_complete
        self.complete_calls = 0
        self.stream_calls = 0

    async def complete(self, req: LLMRequest) -> LLMResponse:
        self.complete_calls += 1
        if self._raise_on_complete:
            raise RuntimeError("provider barfed")
        assert self._complete_response is not None
        return self._complete_response

    def stream(self, req: LLMRequest) -> AsyncIterator[LLMStreamChunk]:
        return self._stream(req)

    async def _stream(self, req: LLMRequest) -> AsyncIterator[LLMStreamChunk]:
        self.stream_calls += 1
        yield LLMStreamChunk(delta="Hel", done=False)
        yield LLMStreamChunk(delta="lo.", done=False)
        yield LLMStreamChunk(
            delta="",
            done=True,
            finish_reason="stop",
            usage=LLMUsage(tokens_in=12, tokens_out=8, cached_tokens_in=4, cache_hit=True),
        )

    async def ping(self) -> dict[str, object]:
        return {"ok": True, "latency_ms": 0}


def _value(counter, **labels: str) -> float:
    metric = next(iter(counter.collect()))
    for sample in metric.samples:
        if sample.name.endswith("_total") and sample.labels == labels:
            return float(sample.value)
    return 0.0


@pytest.fixture(autouse=True)
def _reset_counters() -> None:
    for counter in (PROMPT_CACHE_CHECK, PROMPT_CACHE_HIT, USAGE_TOKENS):
        counter._metrics.clear()  # type: ignore[attr-defined]


def _req() -> LLMRequest:
    return LLMRequest(
        model="llama-3.1-8b-instant",
        messages=[ChannelMessage(role="user", content="hi")],
    )


# ─────────────────────────────────────────────────────────────────────────────
# Protocol surface — wrapped provider must look like the inner
# ─────────────────────────────────────────────────────────────────────────────


def test_wrapper_mirrors_protocol_attributes() -> None:
    inner = _FakeProvider()
    wrapped = MeteredProvider(inner)
    assert wrapped.id == "fake"
    assert wrapped.supports_prompt_cache is True
    assert wrapped.supports_streaming is True
    assert wrapped.context_window_tokens == 8000


# ─────────────────────────────────────────────────────────────────────────────
# complete() — successful call meters
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_complete_increments_check_and_tokens() -> None:
    inner = _FakeProvider(
        complete_response=LLMResponse(
            text="ok",
            finish_reason="stop",
            usage=LLMUsage(tokens_in=100, tokens_out=50, cached_tokens_in=0, cache_hit=False),
            model="m",
            provider_id="fake",
        )
    )
    wrapped = MeteredProvider(inner)
    res = await wrapped.complete(_req())
    assert res.text == "ok"
    assert inner.complete_calls == 1
    assert _value(PROMPT_CACHE_CHECK, provider_id="fake") == 1.0
    assert _value(PROMPT_CACHE_HIT, provider_id="fake") == 0.0
    assert _value(USAGE_TOKENS, provider_id="fake", kind="in") == 100.0
    assert _value(USAGE_TOKENS, provider_id="fake", kind="out") == 50.0


@pytest.mark.asyncio
async def test_complete_bumps_cache_hit_when_cached_tokens_present() -> None:
    inner = _FakeProvider(
        complete_response=LLMResponse(
            text="ok",
            finish_reason="stop",
            usage=LLMUsage(tokens_in=200, tokens_out=20, cached_tokens_in=150, cache_hit=True),
            model="m",
            provider_id="fake",
        )
    )
    wrapped = MeteredProvider(inner)
    await wrapped.complete(_req())
    assert _value(PROMPT_CACHE_HIT, provider_id="fake") == 1.0
    assert _value(USAGE_TOKENS, provider_id="fake", kind="cached_in") == 150.0


# ─────────────────────────────────────────────────────────────────────────────
# complete() — failed call doesn't meter
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_complete_failure_does_not_count() -> None:
    inner = _FakeProvider(raise_on_complete=True)
    wrapped = MeteredProvider(inner)
    with pytest.raises(RuntimeError, match="provider barfed"):
        await wrapped.complete(_req())
    assert _value(PROMPT_CACHE_CHECK, provider_id="fake") == 0.0


# ─────────────────────────────────────────────────────────────────────────────
# stream() — meters only on terminal usage chunk, not per delta
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_stream_meters_only_on_terminal_chunk() -> None:
    inner = _FakeProvider()
    wrapped = MeteredProvider(inner)
    deltas: list[str] = []
    async for chunk in wrapped.stream(_req()):
        deltas.append(chunk.delta)
    assert deltas == ["Hel", "lo.", ""]
    # Three chunks streamed, but only the terminal one with usage counts.
    assert _value(PROMPT_CACHE_CHECK, provider_id="fake") == 1.0
    assert _value(PROMPT_CACHE_HIT, provider_id="fake") == 1.0  # cache_hit=True in terminal chunk
    assert _value(USAGE_TOKENS, provider_id="fake", kind="in") == 12.0
    assert _value(USAGE_TOKENS, provider_id="fake", kind="out") == 8.0
    assert _value(USAGE_TOKENS, provider_id="fake", kind="cached_in") == 4.0


# ─────────────────────────────────────────────────────────────────────────────
# Scrape sanity — metering shows up in /metrics output
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_wrapped_calls_appear_in_metrics_output() -> None:
    inner = _FakeProvider(
        complete_response=LLMResponse(
            text="hi",
            finish_reason="stop",
            usage=LLMUsage(tokens_in=1, tokens_out=1, cached_tokens_in=0, cache_hit=False),
            model="m",
            provider_id="fake",
        )
    )
    wrapped = MeteredProvider(inner)
    await wrapped.complete(_req())
    output = generate_latest().decode("utf-8")
    assert 'provider_id="fake"' in output
    assert "studyforge_prompt_cache_check_total" in output


# ─────────────────────────────────────────────────────────────────────────────
# aclose() forwards to the inner adapter when available
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_aclose_forwards_to_inner() -> None:
    closed = False

    class _Closeable(_FakeProvider):
        async def aclose(self) -> None:
            nonlocal closed
            closed = True

    inner = _Closeable()
    wrapped = MeteredProvider(inner)
    await wrapped.aclose()
    assert closed is True


@pytest.mark.asyncio
async def test_aclose_safe_when_inner_has_none() -> None:
    inner = _FakeProvider()
    wrapped = MeteredProvider(inner)
    # _FakeProvider has no aclose attr — wrapper must not raise.
    await wrapped.aclose()
