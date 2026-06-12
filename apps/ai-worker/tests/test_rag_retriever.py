"""Retriever orchestrator — round-trip with in-memory stubs.

Phase 1 swaps in real BGE-M3 / pgvector / BGE-Reranker implementations behind
the same Protocols. These tests pin the orchestration contract.
"""

from __future__ import annotations

import pytest

from src.rag.contracts import (
    Candidate,
    MetadataFilter,
    RetrievalRequest,
    RetrievalResult,
    RetrievedChunk,
    RetrieverKind,
)
from src.rag.retriever import (
    ChunkResolver,
    DenseRetriever,
    Embedder,
    Reranker,
    RetrievalCache,
    Retriever,
    SparseRetriever,
)

# ── stubs ───────────────────────────────────────────────────────────────────


class StubEmbedder(Embedder):
    async def embed_query(self, text: str) -> list[float]:
        return [float(len(text))]


class StubDense(DenseRetriever):
    def __init__(self, candidates: list[Candidate]) -> None:
        self._c = candidates

    async def search(
        self,
        *,
        embedding: list[float],
        tenant_id: str,
        course_id: str | None,
        folder_id: str | None,
        k: int,
        metadata_filter: MetadataFilter | None,
        chapters: list[int] | None = None,
        allowed_folder_ids: list[str] | None = None,
    ) -> list[Candidate]:
        return self._c[:k]


class StubSparse(SparseRetriever):
    def __init__(self, candidates: list[Candidate]) -> None:
        self._c = candidates

    async def search(
        self,
        *,
        query: str,
        tenant_id: str,
        course_id: str | None,
        folder_id: str | None,
        k: int,
        metadata_filter: MetadataFilter | None,
        chapters: list[int] | None = None,
        allowed_folder_ids: list[str] | None = None,
    ) -> list[Candidate]:
        return self._c[:k]


class StubReranker(Reranker):
    """Identity reranker that preserves input order — useful for asserting on
    fusion + hydration without reranker side-effects."""

    async def rerank(
        self, *, query: str, chunks: list[RetrievedChunk], top_k: int
    ) -> list[RetrievedChunk]:
        return chunks[:top_k]


class DictResolver(ChunkResolver):
    def __init__(self, by_id: dict[str, RetrievedChunk]) -> None:
        self._by_id = by_id

    async def hydrate(self, chunk_ids: list[str]) -> list[RetrievedChunk]:
        return [self._by_id[i] for i in chunk_ids if i in self._by_id]


class RecordingCache(RetrievalCache):
    def __init__(self) -> None:
        self.exact: dict[str, RetrievalResult] = {}
        self.semantic: list[tuple[str, str | None, RetrievalResult]] = []

    async def get_exact(self, key: str) -> RetrievalResult | None:
        return self.exact.get(key)

    async def put_exact(self, key: str, result: RetrievalResult) -> None:
        self.exact[key] = result

    async def get_semantic(
        self, *, embedding: list[float], tenant_id: str, course_id: str | None
    ) -> RetrievalResult | None:
        return None

    async def put_semantic(
        self,
        *,
        embedding: list[float],
        tenant_id: str,
        course_id: str | None,
        result: RetrievalResult,
    ) -> None:
        self.semantic.append((tenant_id, course_id, result))


def _chunk(chunk_id: str) -> RetrievedChunk:
    return RetrievedChunk(
        chunk_id=chunk_id,
        doc_id="doc-1",
        version_id="ver-1",
        page=1,
        char_start=0,
        char_end=100,
        score=0.8,
        content=f"Content for {chunk_id}",
    )


# ── tests ───────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_retriever_returns_fused_reranked_chunks_with_citations() -> None:
    dense_results = [
        Candidate(chunk_id="a", rank=0, score=0.9, kind=RetrieverKind.dense),
        Candidate(chunk_id="b", rank=1, score=0.8, kind=RetrieverKind.dense),
    ]
    sparse_results = [
        Candidate(chunk_id="b", rank=0, score=0.95, kind=RetrieverKind.sparse),
        Candidate(chunk_id="c", rank=1, score=0.7, kind=RetrieverKind.sparse),
    ]
    resolver = DictResolver({"a": _chunk("a"), "b": _chunk("b"), "c": _chunk("c")})
    retriever = Retriever(
        embedder=StubEmbedder(),
        dense=StubDense(dense_results),
        sparse=StubSparse(sparse_results),
        reranker=StubReranker(),
        resolver=resolver,
    )

    out = await retriever.retrieve(
        RetrievalRequest(
            tenant_id="t1",
            course_id="c1",
            query="What is gradient descent?",
            k=3,
        )
    )

    # b appears in both rankings → first after fusion.
    assert [c.chunk_id for c in out.chunks] == ["b", "a", "c"]
    # Citation metadata travels intact.
    assert all(c.doc_id == "doc-1" and c.version_id == "ver-1" for c in out.chunks)
    # Telemetry populated.
    assert out.telemetry.dense_candidates == 2
    assert out.telemetry.sparse_candidates == 2
    assert out.telemetry.fused_candidates == 3
    assert out.telemetry.reranked_returned == 3


@pytest.mark.asyncio
async def test_retriever_returns_empty_when_no_candidates() -> None:
    retriever = Retriever(
        embedder=StubEmbedder(),
        dense=StubDense([]),
        sparse=StubSparse([]),
        reranker=StubReranker(),
        resolver=DictResolver({}),
    )
    out = await retriever.retrieve(
        RetrievalRequest(tenant_id="t1", query="anything")
    )
    assert out.chunks == []
    assert out.diagnostics.get("reason")


@pytest.mark.asyncio
async def test_retriever_serves_from_exact_cache_on_repeat() -> None:
    dense_results = [Candidate(chunk_id="a", rank=0, score=0.9, kind=RetrieverKind.dense)]
    resolver = DictResolver({"a": _chunk("a")})
    cache = RecordingCache()
    retriever = Retriever(
        embedder=StubEmbedder(),
        dense=StubDense(dense_results),
        sparse=StubSparse([]),
        reranker=StubReranker(),
        resolver=resolver,
        cache=cache,
    )
    req = RetrievalRequest(tenant_id="t1", course_id="c1", query="same question?", k=1)

    first = await retriever.retrieve(req)
    assert first.telemetry.exact_cache_hit is False

    second = await retriever.retrieve(req)
    assert second.telemetry.exact_cache_hit is True
    # Cache replay returns the same chunks.
    assert [c.chunk_id for c in second.chunks] == [c.chunk_id for c in first.chunks]
