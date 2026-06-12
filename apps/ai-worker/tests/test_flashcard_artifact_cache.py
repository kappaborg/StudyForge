"""Flashcard agent ↔ artifact cache integration.

Asserts the cross-course sharing exit criterion: a second course with
byte-equal materials gets the donor's deck without an LLM call. The
``_RecordingProvider`` counts ``complete()`` invocations so we can
prove the second course skipped the model.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

import pytest

from src.agents.contracts import (
    FlashcardFromChunksInput,
    RetrievedChunk,
)
from src.agents.flashcard import FlashcardAgent
from src.cache import InMemoryArtifactCache
from src.llm.contracts import (
    LLMProvider,
    LLMRequest,
    LLMResponse,
    LLMStreamChunk,
    LLMUsage,
)


class _RecordingProvider(LLMProvider):
    id = "fake"
    supports_prompt_cache = False
    supports_streaming = False
    context_window_tokens = 8000

    def __init__(self, response_text: str) -> None:
        self._text = response_text
        self.calls = 0

    async def complete(self, req: LLMRequest) -> LLMResponse:
        self.calls += 1
        return LLMResponse(
            text=self._text,
            finish_reason="stop",
            usage=LLMUsage(),
            model=req.model,
            provider_id=self.id,
        )

    def stream(self, req: LLMRequest) -> AsyncIterator[LLMStreamChunk]:  # pragma: no cover
        raise NotImplementedError

    async def ping(self) -> dict[str, object]:  # pragma: no cover
        return {"ok": True, "latency_ms": 0}


def _chunks() -> list[RetrievedChunk]:
    return [
        RetrievedChunk(
            chunk_id="c-photo",
            doc_id="d",
            version_id="v",
            page=1,
            char_start=0,
            char_end=10,
            score=1.0,
            content="Photosynthesis turns light energy into chemical energy.",
        ),
        RetrievedChunk(
            chunk_id="c-chloro",
            doc_id="d",
            version_id="v",
            page=2,
            char_start=0,
            char_end=10,
            score=0.9,
            content="Chlorophyll absorbs light primarily in the blue and red bands.",
        ),
    ]


def _model_response() -> str:
    # Two cards, each citing one of the supplied chunks. Matches the
    # ``_JSON_ARRAY_RE`` parser in the agent.
    return (
        '[{"front":"What does photosynthesis do?","back":"Converts light to '
        'chemical energy.","chunk_id":"c-photo"},'
        '{"front":"What does chlorophyll absorb?","back":"Light in the blue '
        'and red bands.","chunk_id":"c-chloro"}]'
    )


def _payload(*, tenant_id: str, course_id: str, deck_size: int = 2) -> FlashcardFromChunksInput:
    return FlashcardFromChunksInput(
        course_id=course_id,
        tenant_id=tenant_id,
        user_id="00000000-0000-0000-0000-000000000001",
        query="",
        deck_size=deck_size,
    )


# ─────────────────────────────────────────────────────────────────────────────
# Identical chunk sets across two tenants → second is a pure cache hit
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_second_course_with_identical_chunks_hits_cache_no_llm_call() -> None:
    cache = InMemoryArtifactCache()
    provider = _RecordingProvider(_model_response())
    agent = FlashcardAgent(provider=provider, artifact_cache=cache)

    chunks = _chunks()

    out1 = await agent.run(_payload(tenant_id="tenant-A", course_id="course-A"), chunks)
    out2 = await agent.run(_payload(tenant_id="tenant-B", course_id="course-B"), chunks)

    # Donor paid once; tenant-B got the cached deck.
    assert provider.calls == 1

    # Deck contents are byte-equal flashcards. The course_id field is
    # restamped per tenant so the cached output is safe to surface.
    assert len(out1.flashcards) == 2
    assert len(out2.flashcards) == 2
    assert [c.front for c in out1.flashcards] == [c.front for c in out2.flashcards]
    assert out1.course_id == "course-A"
    assert out2.course_id == "course-B"  # restamped, not the donor's


@pytest.mark.asyncio
async def test_different_chunk_set_misses_cache() -> None:
    cache = InMemoryArtifactCache()
    provider = _RecordingProvider(_model_response())
    agent = FlashcardAgent(provider=provider, artifact_cache=cache)

    chunks_A = _chunks()
    # Different chunk_id collection → different content hash → miss.
    chunks_B = [
        RetrievedChunk(
            chunk_id="c-cellresp",
            doc_id="d",
            version_id="v",
            page=1,
            char_start=0,
            char_end=10,
            score=1.0,
            content="Cellular respiration releases energy stored in glucose.",
        ),
    ]

    await agent.run(_payload(tenant_id="tenant-A", course_id="course-A"), chunks_A)
    await agent.run(_payload(tenant_id="tenant-B", course_id="course-B"), chunks_B)

    assert provider.calls == 2  # both miss, both call the LLM


@pytest.mark.asyncio
async def test_different_deck_size_misses_cache_for_same_chunks() -> None:
    """Cache key includes ``deck_size`` because the output shape changes
    with it. Asking for 5 cards over the same chunks shouldn't return
    the donor's 2-card deck."""
    cache = InMemoryArtifactCache()
    provider = _RecordingProvider(_model_response())
    agent = FlashcardAgent(provider=provider, artifact_cache=cache)
    chunks = _chunks()

    await agent.run(
        _payload(tenant_id="t-A", course_id="c-A", deck_size=2), chunks
    )
    await agent.run(
        _payload(tenant_id="t-B", course_id="c-B", deck_size=5), chunks
    )

    assert provider.calls == 2


@pytest.mark.asyncio
async def test_agent_without_cache_still_works() -> None:
    provider = _RecordingProvider(_model_response())
    agent = FlashcardAgent(provider=provider)  # no cache
    out = await agent.run(_payload(tenant_id="t", course_id="c"), _chunks())
    assert len(out.flashcards) == 2
    assert provider.calls == 1


@pytest.mark.asyncio
async def test_no_chunks_short_circuits_before_cache_lookup() -> None:
    """Pre-cache short-circuit: when nothing was retrieved we return an
    empty deck immediately — the agent should not touch the cache (would
    create useless misses for ``chunk_set_hash('')`` keys)."""

    class _NoLookupCache(InMemoryArtifactCache):
        def __init__(self) -> None:
            super().__init__()
            self.lookup_called = False

        async def lookup(self, **kwargs: Any) -> Any:
            self.lookup_called = True
            return await super().lookup(**kwargs)

    cache = _NoLookupCache()
    provider = _RecordingProvider(_model_response())
    agent = FlashcardAgent(provider=provider, artifact_cache=cache)
    out = await agent.run(_payload(tenant_id="t", course_id="c"), [])
    assert out.flashcards == []
    assert cache.lookup_called is False
