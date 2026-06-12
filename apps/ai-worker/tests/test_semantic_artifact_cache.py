"""Semantic analyzer ↔ artifact cache integration.

Concept-graph extraction is the most compute-expensive Phase-2 agent
(highest max_tokens budget, structured JSON parsing across two
collections), so cache-shared graphs across courses with byte-equal
materials are the single biggest cost saving in this surface area.
"""

from __future__ import annotations

from collections.abc import AsyncIterator

import pytest

from src.agents.contracts import RetrievedChunk, SemanticAnalyzerFromChunksInput
from src.agents.semantic import SemanticAnalyzerAgent
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
            content="Photosynthesis converts sunlight into glucose via chlorophyll.",
        ),
        RetrievedChunk(
            chunk_id="c-cell",
            doc_id="d",
            version_id="v",
            page=2,
            char_start=0,
            char_end=10,
            score=0.9,
            content="Chloroplasts house photosynthesis inside plant cells.",
        ),
    ]


def _concept_response() -> str:
    return (
        '{"concepts":['
        '{"local_id":"c1","label":"Photosynthesis",'
        '"description":"Light → glucose","difficulty":40,"chunk_ids":["c-photo"]},'
        '{"local_id":"c2","label":"Chloroplasts",'
        '"description":"Site of photosynthesis","difficulty":30,"chunk_ids":["c-cell"]}'
        '],"edges":['
        '{"from":"c2","to":"c1","kind":"prerequisite_of","weight":0.9}'
        ']}'
    )


def _payload(
    *,
    tenant_id: str,
    course_id: str,
    max_concepts: int = 8,
) -> SemanticAnalyzerFromChunksInput:
    return SemanticAnalyzerFromChunksInput(
        course_id=course_id,
        tenant_id=tenant_id,
        user_id="00000000-0000-0000-0000-000000000001",
        max_concepts=max_concepts,
    )


@pytest.mark.asyncio
async def test_second_course_with_identical_chunks_hits_semantic_cache() -> None:
    cache = InMemoryArtifactCache()
    provider = _RecordingProvider(_concept_response())
    agent = SemanticAnalyzerAgent(provider=provider, artifact_cache=cache)
    chunks = _chunks()

    g1 = await agent.run(_payload(tenant_id="t-A", course_id="c-A"), chunks)
    g2 = await agent.run(_payload(tenant_id="t-B", course_id="c-B"), chunks)

    assert provider.calls == 1
    # Same concept set + edges, restamped course_id.
    assert [c.label for c in g1.concepts] == [c.label for c in g2.concepts]
    assert len(g2.edges) == len(g1.edges) == 1
    assert g2.course_id == "c-B"


@pytest.mark.asyncio
async def test_different_max_concepts_does_not_share_donor_graph() -> None:
    """A graph capped at 6 concepts has a denser edge density than one
    capped at 20 — they're different artifacts even from the same chunks."""
    cache = InMemoryArtifactCache()
    provider = _RecordingProvider(_concept_response())
    agent = SemanticAnalyzerAgent(provider=provider, artifact_cache=cache)
    chunks = _chunks()

    await agent.run(
        _payload(tenant_id="t-A", course_id="c-A", max_concepts=6), chunks
    )
    await agent.run(
        _payload(tenant_id="t-B", course_id="c-B", max_concepts=20), chunks
    )

    assert provider.calls == 2


@pytest.mark.asyncio
async def test_agent_without_cache_still_works() -> None:
    provider = _RecordingProvider(_concept_response())
    agent = SemanticAnalyzerAgent(provider=provider)
    out = await agent.run(_payload(tenant_id="t", course_id="c"), _chunks())
    assert len(out.concepts) == 2
    assert provider.calls == 1


@pytest.mark.asyncio
async def test_no_chunks_short_circuits_before_cache_lookup() -> None:
    cache = InMemoryArtifactCache()
    provider = _RecordingProvider(_concept_response())
    agent = SemanticAnalyzerAgent(provider=provider, artifact_cache=cache)
    out = await agent.run(_payload(tenant_id="t", course_id="c"), [])
    assert out.concepts == []
    assert provider.calls == 0
