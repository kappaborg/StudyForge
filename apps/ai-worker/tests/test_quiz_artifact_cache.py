"""Quiz agent ↔ artifact cache integration.

Same exit shape as the flashcard suite: identical chunks across two
tenants → second tenant gets a free hit. Additional cases verify that
``item_count`` + ``difficulty`` partition the cache so a "10 hard
questions" donor doesn't accidentally serve a "5 easy" consumer.

The ``require_validated`` flag's strict semantics are also covered
here — it's the lever the Phase 2 quiz exit criterion (rationale-
consistency ≥ 0.95) hangs on, so the test that the strict flag MISSES
unvalidated donors is load-bearing for the Phase B-4 follow-up.
"""

from __future__ import annotations

from collections.abc import AsyncIterator

import pytest

from src.agents.contracts import QuizFromChunksInput, RetrievedChunk
from src.agents.quiz import QuizAgent
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
            content="Photosynthesis converts light energy into chemical energy.",
        ),
    ]


def _quiz_response() -> str:
    return (
        '[{"prompt":"What does photosynthesis convert?",'
        '"options":["Light to chemical","Light to thermal",'
        '"Chemical to light","Light to potential"],'
        '"correct_index":0,'
        '"rationale":"Photosynthesis converts light into chemical energy.",'
        '"chunk_id":"c-photo"}]'
    )


def _payload(
    *,
    tenant_id: str,
    course_id: str,
    item_count: int = 1,
    difficulty: int = 50,
) -> QuizFromChunksInput:
    return QuizFromChunksInput(
        course_id=course_id,
        tenant_id=tenant_id,
        user_id="00000000-0000-0000-0000-000000000001",
        item_count=item_count,
        difficulty=difficulty,
    )


# ─────────────────────────────────────────────────────────────────────────────
# Cross-course sharing
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_second_course_with_identical_chunks_hits_quiz_cache() -> None:
    cache = InMemoryArtifactCache()
    provider = _RecordingProvider(_quiz_response())
    agent = QuizAgent(provider=provider, artifact_cache=cache)
    chunks = _chunks()

    q1 = await agent.run(_payload(tenant_id="t-A", course_id="c-A"), chunks)
    q2 = await agent.run(_payload(tenant_id="t-B", course_id="c-B"), chunks)

    assert provider.calls == 1
    assert len(q1.items) == 1
    assert len(q2.items) == 1
    assert q1.items[0].prompt == q2.items[0].prompt
    assert q2.course_id == "c-B"  # restamped, not the donor's


# ─────────────────────────────────────────────────────────────────────────────
# Cache-key partition: item_count + difficulty must change the key
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_different_item_count_does_not_share_donor_quiz() -> None:
    """A "5 questions" donor must not serve a "10 questions" consumer —
    the output shape literally changes."""
    cache = InMemoryArtifactCache()
    provider = _RecordingProvider(_quiz_response())
    agent = QuizAgent(provider=provider, artifact_cache=cache)
    chunks = _chunks()

    await agent.run(
        _payload(tenant_id="t-A", course_id="c-A", item_count=1), chunks
    )
    await agent.run(
        _payload(tenant_id="t-B", course_id="c-B", item_count=5), chunks
    )

    assert provider.calls == 2


@pytest.mark.asyncio
async def test_different_difficulty_does_not_share_donor_quiz() -> None:
    """The prompt steers distractor sophistication on difficulty; an
    easy quiz's distractors won't satisfy a hard consumer."""
    cache = InMemoryArtifactCache()
    provider = _RecordingProvider(_quiz_response())
    agent = QuizAgent(provider=provider, artifact_cache=cache)
    chunks = _chunks()

    await agent.run(
        _payload(tenant_id="t-A", course_id="c-A", difficulty=20), chunks
    )
    await agent.run(
        _payload(tenant_id="t-B", course_id="c-B", difficulty=80), chunks
    )

    assert provider.calls == 2


# ─────────────────────────────────────────────────────────────────────────────
# require_validated — Phase 2 exit criterion lever
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_strict_consumer_misses_unvalidated_donor() -> None:
    """Phase 2 quiz exit criterion is rationale-consistency ≥ 0.95;
    until Phase B-4 wires Ragas, no row has ``quality_validated=True``.
    A strict QuizAgent must regenerate rather than serve unvalidated."""
    cache = InMemoryArtifactCache()
    provider = _RecordingProvider(_quiz_response())

    lenient_donor = QuizAgent(provider=provider, artifact_cache=cache)
    strict_consumer = QuizAgent(
        provider=provider,
        artifact_cache=cache,
        require_validated_cache_hits=True,
    )
    chunks = _chunks()

    await lenient_donor.run(_payload(tenant_id="t-A", course_id="c-A"), chunks)
    await strict_consumer.run(_payload(tenant_id="t-B", course_id="c-B"), chunks)

    # Strict consumer missed the unvalidated donor row → both calls hit LLM.
    assert provider.calls == 2


@pytest.mark.asyncio
async def test_strict_consumer_hits_after_donor_is_validated() -> None:
    cache = InMemoryArtifactCache()
    provider = _RecordingProvider(_quiz_response())

    donor = QuizAgent(provider=provider, artifact_cache=cache)
    strict_consumer = QuizAgent(
        provider=provider,
        artifact_cache=cache,
        require_validated_cache_hits=True,
    )
    chunks = _chunks()

    await donor.run(_payload(tenant_id="t-A", course_id="c-A"), chunks)
    # Simulate the Phase B-4 Ragas gate having passed on the donor's row.
    await cache.mark_validated(
        content_hash=donor._content_hash(chunks, 1, 50),
        agent_name=QuizAgent.name,
        agent_version=QuizAgent.version,
    )
    await strict_consumer.run(_payload(tenant_id="t-B", course_id="c-B"), chunks)

    # Strict consumer hit the now-validated donor row → only one LLM call total.
    assert provider.calls == 1
