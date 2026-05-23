"""Semantic cache — util, InMemorySemanticCache, and TutorAgent integration.

The Postgres backend is covered by an integration test gated on Postgres
reachability (see ``test_cache_postgres.py``).
"""

from __future__ import annotations

from collections.abc import AsyncIterator

import pytest

from src.agents.contracts import Citation, RetrievedChunk, TutorInput
from src.agents.tutor import TutorAgent
from src.cache import InMemorySemanticCache, chunk_set_hash
from src.llm.contracts import (
    LLMProvider,
    LLMRequest,
    LLMResponse,
    LLMStreamChunk,
    LLMUsage,
)
from src.rag.embedder import StubEmbedder


# ── chunk_set_hash util ──────────────────────────────────────────────────────


def test_chunk_set_hash_is_order_independent() -> None:
    assert chunk_set_hash(["a", "b", "c"]) == chunk_set_hash(["c", "b", "a"])


def test_chunk_set_hash_dedupes_inputs() -> None:
    assert chunk_set_hash(["a", "b", "a"]) == chunk_set_hash(["a", "b"])


def test_chunk_set_hash_changes_when_set_differs() -> None:
    assert chunk_set_hash(["a", "b"]) != chunk_set_hash(["a", "c"])


# ── InMemorySemanticCache standalone ─────────────────────────────────────────


def _citation(chunk_id: str) -> Citation:
    return Citation(
        chunk_id=chunk_id,
        doc_id="d1",
        version_id="v1",
        page=1,
        slide=None,
        cell=None,
        char_start=0,
        char_end=10,
        score=0.9,
    )


@pytest.mark.asyncio
async def test_inmemory_cache_returns_none_on_empty() -> None:
    cache = InMemorySemanticCache(embedder=StubEmbedder())
    hit = await cache.lookup(
        query="anything",
        tenant_id="t1",
        course_id="c1",
        chunk_set_hash="h",
    )
    assert hit is None


@pytest.mark.asyncio
async def test_inmemory_cache_round_trips_identical_query() -> None:
    cache = InMemorySemanticCache(embedder=StubEmbedder())
    await cache.store(
        query="What is gradient descent?",
        tenant_id="t1",
        course_id="c1",
        chunk_set_hash="abc",
        response="Gradient descent moves against the gradient.",
        citations=[_citation("c1")],
        freshness_sec=300,
    )
    hit = await cache.lookup(
        query="What is gradient descent?",
        tenant_id="t1",
        course_id="c1",
        chunk_set_hash="abc",
    )
    assert hit is not None
    assert hit.similarity == pytest.approx(1.0, abs=1e-6)
    assert hit.hits == 1
    assert hit.citations[0].chunk_id == "c1"


@pytest.mark.asyncio
async def test_inmemory_cache_isolates_by_tenant() -> None:
    cache = InMemorySemanticCache(embedder=StubEmbedder())
    await cache.store(
        query="Q",
        tenant_id="t1",
        course_id="c1",
        chunk_set_hash="h",
        response="r",
        citations=[_citation("c1")],
    )
    assert await cache.lookup(
        query="Q", tenant_id="t2", course_id="c1", chunk_set_hash="h"
    ) is None


@pytest.mark.asyncio
async def test_inmemory_cache_isolates_by_chunk_set_hash() -> None:
    cache = InMemorySemanticCache(embedder=StubEmbedder())
    await cache.store(
        query="Q",
        tenant_id="t1",
        course_id="c1",
        chunk_set_hash="hA",
        response="r",
        citations=[_citation("c1")],
    )
    # Different corpus → different chunk_set_hash → no leak.
    assert await cache.lookup(
        query="Q", tenant_id="t1", course_id="c1", chunk_set_hash="hB"
    ) is None


@pytest.mark.asyncio
async def test_inmemory_cache_respects_similarity_threshold() -> None:
    cache = InMemorySemanticCache(embedder=StubEmbedder())
    await cache.store(
        query="Define entropy.",
        tenant_id="t1",
        course_id="c1",
        chunk_set_hash="h",
        response="r",
        citations=[_citation("c1")],
    )
    # Different text → different stub embedding → cosine ≪ 0.92.
    hit = await cache.lookup(
        query="What is the capital of France?",
        tenant_id="t1",
        course_id="c1",
        chunk_set_hash="h",
    )
    assert hit is None


# ── TutorAgent integration ──────────────────────────────────────────────────


class _RecordingProvider(LLMProvider):
    id: str = "rec"
    supports_prompt_cache: bool = False
    supports_streaming: bool = False
    context_window_tokens: int = 8000

    def __init__(self, text: str = "Answer [chunk:c1].") -> None:
        self._text = text
        self.call_count = 0

    async def complete(self, req: LLMRequest) -> LLMResponse:
        self.call_count += 1
        return LLMResponse(
            text=self._text,
            finish_reason="stop",
            usage=LLMUsage(tokens_in=10, tokens_out=4),
            model=req.model,
            provider_id=self.id,
        )

    def stream(self, req: LLMRequest) -> AsyncIterator[LLMStreamChunk]:  # pragma: no cover
        raise NotImplementedError

    async def ping(self) -> dict[str, object]:  # pragma: no cover
        return {"ok": True, "latency_ms": 0}


def _payload(query: str = "What is gradient descent?", *, tenant_id: str | None = "t1") -> TutorInput:
    chunk = RetrievedChunk(
        chunk_id="c1",
        doc_id="d1",
        version_id="v1",
        page=12,
        char_start=0,
        char_end=120,
        score=0.92,
        content="Gradient descent moves against the gradient.",
    )
    return TutorInput(
        session_id="11111111-1111-1111-1111-111111111111",
        user_id="22222222-2222-2222-2222-222222222222",
        tenant_id=tenant_id,
        query=query,
        retrieved_chunks=[chunk],
    )


@pytest.mark.asyncio
async def test_tutor_does_not_call_provider_on_cache_hit() -> None:
    cache = InMemorySemanticCache(embedder=StubEmbedder())
    provider = _RecordingProvider()
    agent = TutorAgent(provider=provider, cache=cache)

    # Cold call — provider is invoked, response is cached.
    first = await agent.run(_payload())
    assert first.refusal is False
    assert provider.call_count == 1
    assert {c.chunk_id for c in first.citations} == {"c1"}

    # Warm call — same query + chunks → cache hit → provider NOT called again.
    second = await agent.run(_payload())
    assert second.refusal is False
    assert provider.call_count == 1
    assert second.text == first.text
    assert {c.chunk_id for c in second.citations} == {"c1"}


@pytest.mark.asyncio
async def test_tutor_misses_cache_when_corpus_changes() -> None:
    cache = InMemorySemanticCache(embedder=StubEmbedder())
    provider = _RecordingProvider()
    agent = TutorAgent(provider=provider, cache=cache)
    await agent.run(_payload())
    assert provider.call_count == 1

    # Same query, different chunk → new chunk_set_hash → miss.
    different_chunk = RetrievedChunk(
        chunk_id="c2",
        doc_id="d2",
        version_id="v2",
        page=1,
        char_start=0,
        char_end=10,
        score=0.91,
        content="A different fact.",
    )
    payload = _payload()
    payload = payload.model_copy(update={"retrieved_chunks": [different_chunk]})
    # The model needs to cite the new chunk now.
    provider2 = _RecordingProvider(text="Answer [chunk:c2].")
    agent.__init__(provider=provider2, cache=cache)
    await agent.run(payload)
    assert provider2.call_count == 1


@pytest.mark.asyncio
async def test_tutor_skips_cache_when_tenant_id_missing() -> None:
    cache = InMemorySemanticCache(embedder=StubEmbedder())
    provider = _RecordingProvider()
    agent = TutorAgent(provider=provider, cache=cache)
    # tenant_id = None → cache is bypassed.
    await agent.run(_payload(tenant_id=None))
    await agent.run(_payload(tenant_id=None))
    assert provider.call_count == 2
    # Cache must not have grown either — store also bails on None tenant.
    assert cache.entries == []


@pytest.mark.asyncio
async def test_tutor_does_not_cache_refusals() -> None:
    cache = InMemorySemanticCache(embedder=StubEmbedder())
    provider = _RecordingProvider(text="Answer without citation tag.")
    agent = TutorAgent(provider=provider, cache=cache)
    out = await agent.run(_payload())
    assert out.refusal is True  # uncited → refusal path
    assert cache.entries == []  # never cache a refusal as positive answer


@pytest.mark.asyncio
async def test_tutor_cache_lookup_failure_does_not_break_user_path() -> None:
    class BoomCache(InMemorySemanticCache):
        async def lookup(self, **_: object) -> None:  # type: ignore[override]
            raise RuntimeError("redis blip")

    cache = BoomCache(embedder=StubEmbedder())
    provider = _RecordingProvider()
    agent = TutorAgent(provider=provider, cache=cache)
    out = await agent.run(_payload())
    # User still gets a valid answer even though the cache exploded.
    assert out.refusal is False
    assert provider.call_count == 1
