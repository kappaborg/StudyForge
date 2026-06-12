"""Roadmap agent ↔ artifact cache integration.

Roadmaps share unvalidated rows (like flashcards) — the FE labels
donor-shared plans distinctly so the student knows what they're
looking at. The cache key includes ``weeks`` because the plan shape
literally changes with it.
"""

from __future__ import annotations

from collections.abc import AsyncIterator

import pytest

from src.agents.contracts import RetrievedChunk, RoadmapFromChunksInput
from src.agents.roadmap import RoadmapAgent
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
            chunk_id="c-cells",
            doc_id="d",
            version_id="v",
            page=1,
            char_start=0,
            char_end=10,
            score=1.0,
            content="Cells are the basic structural unit of all living organisms.",
        ),
        RetrievedChunk(
            chunk_id="c-dna",
            doc_id="d",
            version_id="v",
            page=2,
            char_start=0,
            char_end=10,
            score=0.9,
            content="DNA carries genetic information across generations.",
        ),
    ]


def _roadmap_response() -> str:
    return (
        '{"weeks":[{"title":"Foundations","milestones":['
        '{"title":"Intro to cells","effort_min":45,"chunk_id":"c-cells"},'
        '{"title":"DNA basics","effort_min":60,"chunk_id":"c-dna"}'
        "]}]}"
    )


def _payload(
    *,
    tenant_id: str,
    course_id: str,
    weeks: int = 1,
) -> RoadmapFromChunksInput:
    return RoadmapFromChunksInput(
        course_id=course_id,
        tenant_id=tenant_id,
        user_id="00000000-0000-0000-0000-000000000001",
        weeks=weeks,
    )


@pytest.mark.asyncio
async def test_second_course_with_identical_chunks_hits_roadmap_cache() -> None:
    cache = InMemoryArtifactCache()
    provider = _RecordingProvider(_roadmap_response())
    agent = RoadmapAgent(provider=provider, artifact_cache=cache)
    chunks = _chunks()

    r1 = await agent.run(_payload(tenant_id="t-A", course_id="c-A"), chunks)
    r2 = await agent.run(_payload(tenant_id="t-B", course_id="c-B"), chunks)

    assert provider.calls == 1
    # Same milestone set, restamped course_id.
    assert [m.title for m in r1.milestones] == [m.title for m in r2.milestones]
    assert r2.course_id == "c-B"


@pytest.mark.asyncio
async def test_different_weeks_does_not_share_donor_roadmap() -> None:
    """A 1-week plan can't substitute for a 4-week plan — the milestone
    distribution is shaped by the week count."""
    cache = InMemoryArtifactCache()
    provider = _RecordingProvider(_roadmap_response())
    agent = RoadmapAgent(provider=provider, artifact_cache=cache)
    chunks = _chunks()

    await agent.run(
        _payload(tenant_id="t-A", course_id="c-A", weeks=1), chunks
    )
    await agent.run(
        _payload(tenant_id="t-B", course_id="c-B", weeks=4), chunks
    )

    assert provider.calls == 2


@pytest.mark.asyncio
async def test_agent_without_cache_still_works() -> None:
    provider = _RecordingProvider(_roadmap_response())
    agent = RoadmapAgent(provider=provider)  # no cache
    out = await agent.run(_payload(tenant_id="t", course_id="c"), _chunks())
    assert len(out.milestones) == 2
    assert provider.calls == 1


@pytest.mark.asyncio
async def test_no_chunks_short_circuits_before_cache_lookup() -> None:
    cache = InMemoryArtifactCache()
    provider = _RecordingProvider(_roadmap_response())
    agent = RoadmapAgent(provider=provider, artifact_cache=cache)
    out = await agent.run(_payload(tenant_id="t", course_id="c"), [])
    assert out.milestones == []
    assert provider.calls == 0
