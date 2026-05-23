"""Tutor agent — the citation-enforcement invariant.

These tests guard the load-bearing rule from §5: a tutor response either
carries at least one valid citation OR is a typed refusal. The orchestrator
may not paper over this with retries; the response builder may not synthesise
an answer.

Phase-1 additions verify the LLM-call path against a fake provider so we can
assert behaviour without a real API key.
"""

from __future__ import annotations

from collections.abc import AsyncIterator

import pytest

from src.agents.tutor import (
    CITATION_TAG_RE,
    TutorAgent,
    _extract_cited_chunk_ids,
    _strip_citation_tags,
)
from src.agents.contracts import RetrievedChunk, TutorInput
from src.llm.contracts import (
    LLMProvider,
    LLMRequest,
    LLMResponse,
    LLMStreamChunk,
    LLMUsage,
)


# ── shared helpers ────────────────────────────────────────────────────────────


def _chunk(
    chunk_id: str, content: str = "irrelevant", score: float = 0.91
) -> RetrievedChunk:
    return RetrievedChunk(
        chunk_id=chunk_id,
        doc_id="d1",
        version_id="v1",
        page=12,
        char_start=0,
        char_end=120,
        score=score,
        content=content,
    )


def _input(
    *,
    query: str = "What is gradient descent?",
    chunks: list[RetrievedChunk] | None = None,
) -> TutorInput:
    return TutorInput(
        session_id="11111111-1111-1111-1111-111111111111",
        user_id="22222222-2222-2222-2222-222222222222",
        query=query,
        retrieved_chunks=chunks or [],
    )


class FakeProvider(LLMProvider):
    """In-process LLM stand-in. Records the last request for assertions."""

    id = "fake"
    supports_prompt_cache = False
    supports_streaming = False
    context_window_tokens = 8000

    def __init__(
        self, response_text: str, *, raise_on_call: BaseException | None = None
    ) -> None:
        self._text = response_text
        self._raise = raise_on_call
        self.last_request: LLMRequest | None = None

    async def complete(self, req: LLMRequest) -> LLMResponse:
        self.last_request = req
        if self._raise is not None:
            raise self._raise
        return LLMResponse(
            text=self._text,
            finish_reason="stop",
            usage=LLMUsage(tokens_in=42, tokens_out=18, cache_hit=False),
            model=req.model,
            provider_id="fake",
        )

    def stream(self, req: LLMRequest) -> AsyncIterator[LLMStreamChunk]:  # pragma: no cover
        raise NotImplementedError

    async def ping(self) -> dict[str, object]:  # pragma: no cover
        return {"ok": True, "latency_ms": 0}


# ── refusal paths (unchanged from Phase 0) ──────────────────────────────────


@pytest.mark.asyncio
async def test_tutor_refuses_when_no_chunks_supplied() -> None:
    agent = TutorAgent()
    out = await agent.run(_input())
    assert out.refusal is True
    assert out.citations == []
    assert "could not find this" in out.text.lower()


@pytest.mark.asyncio
async def test_tutor_refuses_when_chunks_below_support_threshold() -> None:
    agent = TutorAgent()
    out = await agent.run(
        _input(
            chunks=[_chunk("c1", "A tangentially related sentence.", score=0.10)]
        )
    )
    assert out.refusal is True
    assert out.citations == []
    assert any(out.suggestions)


@pytest.mark.asyncio
async def test_tutor_returns_stub_when_no_provider_and_supportive_chunks() -> None:
    # Phase-0 backward-compatible path: chunks supportive, provider not wired.
    agent = TutorAgent()
    out = await agent.run(
        _input(
            chunks=[
                _chunk("c1", "Gradient descent moves against the gradient.", score=0.92)
            ]
        )
    )
    assert out.refusal is False
    assert len(out.citations) == 1
    assert "No LLM provider key is configured" in out.text  # stub is clearly labelled
    assert "[chunk:c1]" in out.text  # excerpt carries citation tag


# ── Phase-1 LLM-call path ──────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_tutor_returns_cited_response_with_provider() -> None:
    provider = FakeProvider(
        "Gradient descent moves against the gradient [chunk:c1]. "
        "The learning rate scales each step [chunk:c2]."
    )
    agent = TutorAgent(provider=provider)
    out = await agent.run(
        _input(
            chunks=[
                _chunk("c1", "Gradient descent moves against the gradient.", score=0.92),
                _chunk("c2", "The learning rate scales each step.", score=0.78),
            ]
        )
    )
    assert out.refusal is False
    assert {c.chunk_id for c in out.citations} == {"c1", "c2"}
    assert "[chunk:" not in out.text
    assert "moves against the gradient" in out.text
    # Provider was called through the channel-separated prompt builder.
    assert provider.last_request is not None
    assert any(m.role == "system" for m in provider.last_request.messages)
    assert any(
        "<untrusted_document" in m.content for m in provider.last_request.messages
    )


@pytest.mark.asyncio
async def test_tutor_drops_hallucinated_citations() -> None:
    # Model invented `c99` which we never retrieved. Tag must be dropped; only
    # the real `c1` survives as a citation.
    provider = FakeProvider(
        "First the descent [chunk:c1]. Then a hallucinated fact [chunk:c99]."
    )
    agent = TutorAgent(provider=provider)
    out = await agent.run(
        _input(chunks=[_chunk("c1", "Gradient descent definition.", score=0.91)])
    )
    assert out.refusal is False
    assert {c.chunk_id for c in out.citations} == {"c1"}


@pytest.mark.asyncio
async def test_tutor_refuses_when_model_returns_uncited_response() -> None:
    # Model ignored the citation instruction. Per §5 contract this is a
    # refusal — never returned as an "answer."
    provider = FakeProvider("Gradient descent is just an optimisation algorithm.")
    agent = TutorAgent(provider=provider)
    out = await agent.run(
        _input(chunks=[_chunk("c1", "Gradient descent definition.", score=0.91)])
    )
    assert out.refusal is True
    assert out.citations == []
    assert "citation-grounded" in out.text


@pytest.mark.asyncio
async def test_tutor_refuses_on_llm_error() -> None:
    provider = FakeProvider("won't matter", raise_on_call=RuntimeError("HTTP 502"))
    agent = TutorAgent(provider=provider)
    out = await agent.run(
        _input(chunks=[_chunk("c1", "Gradient descent definition.", score=0.91)])
    )
    assert out.refusal is True
    assert out.citations == []
    assert "Try again" in out.text


@pytest.mark.asyncio
async def test_tutor_passes_through_model_and_user_to_provider() -> None:
    provider = FakeProvider("ok [chunk:c1].")
    agent = TutorAgent(
        provider=provider, model="llama-test", max_output_tokens=128, temperature=0.0
    )
    payload = _input(chunks=[_chunk("c1", "Definition.", score=0.91)])
    await agent.run(payload)
    assert provider.last_request is not None
    assert provider.last_request.model == "llama-test"
    assert provider.last_request.max_output_tokens == 128
    assert provider.last_request.temperature == 0.0
    assert provider.last_request.user == payload.user_id


# ── citation-tag parser units ───────────────────────────────────────────────


def test_extract_cited_chunk_ids_dedupes_in_order() -> None:
    text = "First [chunk:c1] then [chunk:c2] then [chunk:c1] again."
    assert _extract_cited_chunk_ids(text) == ["c1", "c2"]


def test_extract_cited_chunk_ids_returns_empty_when_absent() -> None:
    assert _extract_cited_chunk_ids("no tags here") == []


def test_strip_citation_tags_removes_markers() -> None:
    assert _strip_citation_tags("foo [chunk:x] bar [chunk:y].") == "foo  bar ."


def test_citation_tag_regex_only_matches_safe_chars() -> None:
    # ids may contain alphanumerics, underscore, and hyphen
    assert CITATION_TAG_RE.findall("[chunk:abc_123-XYZ]") == ["abc_123-XYZ"]
    # spaces / other punctuation break the match
    assert CITATION_TAG_RE.findall("[chunk:not allowed]") == []


# ── Phase 1 #7 · prompt caching wiring ───────────────────────────────────────


@pytest.mark.asyncio
async def test_tutor_marks_cacheable_prefix_on_provider_call() -> None:
    """The Anthropic adapter only emits ``cache_control: ephemeral`` when the
    request carries ``cache_prefix_boundary``. The tutor MUST set it on every
    LLM call so multi-turn sessions amortise the system + chunks cost."""
    provider = FakeProvider("Answer [chunk:c1].")
    agent = TutorAgent(provider=provider)
    await agent.run(
        _input(chunks=[_chunk("c1", "Definition.", score=0.92)])
    )
    assert provider.last_request is not None
    assert provider.last_request.cache_prefix_boundary == 1


@pytest.mark.asyncio
async def test_tutor_logs_cache_stats_on_each_llm_call(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Cost telemetry: every LLM call emits a structured log line carrying
    cache stats. The cost-ledger writer (Phase 1 #8 onward) reads these."""
    import logging

    caplog.set_level(logging.INFO, logger="src.agents.tutor")
    provider = FakeProvider("Answer [chunk:c1].")
    agent = TutorAgent(provider=provider)
    await agent.run(
        _input(chunks=[_chunk("c1", "Definition.", score=0.92)])
    )
    matching = [r for r in caplog.records if r.getMessage() == "tutor.llm_call"]
    assert len(matching) == 1
    record = matching[0]
    # All keys present even when the provider doesn't actually cache.
    for key in (
        "provider_id",
        "model",
        "tokens_in",
        "tokens_out",
        "cached_tokens_in",
        "cache_hit",
        "cache_hit_ratio",
        "finish_reason",
        "agent",
    ):
        assert hasattr(record, key), f"log record missing {key!r}"
    assert record.provider_id == "fake"  # FakeProvider's id
    assert record.cache_hit is False
    assert record.cached_tokens_in == 0
    assert record.cache_hit_ratio == 0.0
    assert record.agent == "tutor.answer.v1"


@pytest.mark.asyncio
async def test_tutor_log_records_real_cache_hit_when_provider_reports_one(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """When the provider reports a cache hit (e.g. Anthropic's
    ``cache_read_input_tokens``), the log line carries the non-zero ratio."""
    import logging

    from src.llm.contracts import LLMResponse, LLMUsage

    class CachingProvider(FakeProvider):
        async def complete(self, req):  # type: ignore[no-untyped-def, override]
            self.last_request = req
            return LLMResponse(
                text="Answer [chunk:c1].",
                finish_reason="stop",
                usage=LLMUsage(tokens_in=100, tokens_out=12, cached_tokens_in=80, cache_hit=True),
                model=req.model,
                provider_id="anthropic-fake",
            )

    caplog.set_level(logging.INFO, logger="src.agents.tutor")
    agent = TutorAgent(provider=CachingProvider("unused"))
    await agent.run(
        _input(chunks=[_chunk("c1", "Definition.", score=0.92)])
    )
    record = next(r for r in caplog.records if r.getMessage() == "tutor.llm_call")
    assert record.cache_hit is True
    assert record.cached_tokens_in == 80
    assert record.cache_hit_ratio == 0.8
