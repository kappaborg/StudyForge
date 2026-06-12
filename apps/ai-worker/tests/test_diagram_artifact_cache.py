"""Diagram agent ↔ artifact cache integration.

Mermaid DSL output is the cheapest of the chunk-driven generators —
strict output, easy to verify. Caching across courses still matters
because students of related courses often request the same flowchart
shape (e.g. mitosis stages across Biology 101 sections).

The ``kind`` parameter selects DSL family entirely (flowchart vs
mindmap vs sequence) — a flowchart donor cannot serve a sequence
consumer.
"""

from __future__ import annotations

from collections.abc import AsyncIterator

import pytest

from src.agents.contracts import DiagramFromChunksInput, RetrievedChunk
from src.agents.diagram import DiagramAgent
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
            chunk_id="c-input",
            doc_id="d",
            version_id="v",
            page=1,
            char_start=0,
            char_end=10,
            score=1.0,
            content="User clicks submit. Form data flows into the validator.",
        ),
        RetrievedChunk(
            chunk_id="c-output",
            doc_id="d",
            version_id="v",
            page=2,
            char_start=0,
            char_end=10,
            score=0.9,
            content="Validated data is persisted to the database.",
        ),
    ]


def _flowchart_dsl() -> str:
    return (
        "flowchart TD\n"
        "  A[Submit] --> B[Validator]\n"
        "  B --> C[Database]\n"
    )


def _payload(
    *,
    tenant_id: str,
    course_id: str,
    kind: str = "flowchart",
) -> DiagramFromChunksInput:
    return DiagramFromChunksInput(
        course_id=course_id,
        tenant_id=tenant_id,
        user_id="00000000-0000-0000-0000-000000000001",
        kind=kind,  # type: ignore[arg-type]
    )


@pytest.mark.asyncio
async def test_second_course_with_identical_chunks_hits_diagram_cache() -> None:
    cache = InMemoryArtifactCache()
    provider = _RecordingProvider(_flowchart_dsl())
    agent = DiagramAgent(provider=provider, artifact_cache=cache)
    chunks = _chunks()

    d1 = await agent.run(_payload(tenant_id="t-A", course_id="c-A"), chunks)
    d2 = await agent.run(_payload(tenant_id="t-B", course_id="c-B"), chunks)

    assert provider.calls == 1
    assert d1.source == d2.source
    assert d2.course_id == "c-B"


@pytest.mark.asyncio
async def test_different_kind_does_not_share_donor_diagram() -> None:
    """A flowchart donor cannot serve a mindmap consumer — they're
    entirely different DSL families that Mermaid renders differently."""
    cache = InMemoryArtifactCache()
    # Mindmap DSL: valid for the 'mindmap' kind.
    mindmap_dsl = "mindmap\n  root((StudyForge))\n    A\n    B\n"
    flow_provider = _RecordingProvider(_flowchart_dsl())
    mindmap_provider = _RecordingProvider(mindmap_dsl)

    flow_agent = DiagramAgent(provider=flow_provider, artifact_cache=cache)
    mindmap_agent = DiagramAgent(provider=mindmap_provider, artifact_cache=cache)
    chunks = _chunks()

    await flow_agent.run(
        _payload(tenant_id="t-A", course_id="c-A", kind="flowchart"), chunks
    )
    await mindmap_agent.run(
        _payload(tenant_id="t-B", course_id="c-B", kind="mindmap"), chunks
    )

    # Each kind generated independently; no cross-kind contamination.
    assert flow_provider.calls == 1
    assert mindmap_provider.calls == 1


@pytest.mark.asyncio
async def test_agent_without_cache_still_works() -> None:
    provider = _RecordingProvider(_flowchart_dsl())
    agent = DiagramAgent(provider=provider)
    out = await agent.run(_payload(tenant_id="t", course_id="c"), _chunks())
    assert out.source.startswith("flowchart TD")
    assert provider.calls == 1
