"""Retrieval orchestrator.

Hybrid (dense + sparse) → RRF fusion → rerank → return chunks. Every backend is
behind a Protocol so tests and Phase-0 wiring can supply in-memory stubs while
Phase 1 swaps in real BGE-M3 / pgvector / BGE-Reranker implementations.
"""

from __future__ import annotations

import time
from typing import Protocol

from .contracts import (
    Candidate,
    MetadataFilter,
    RetrievalRequest,
    RetrievalResult,
    RetrievalTelemetry,
    RetrievedChunk,
    RetrieverKind,
)
from .fusion import reciprocal_rank_fusion


# ─────────────────────────────────────────────────────────────────────────────
# Pluggable boundaries
# ─────────────────────────────────────────────────────────────────────────────


class Embedder(Protocol):
    """Produces embeddings. BGE-M3 in production; deterministic stub in tests."""

    async def embed_query(self, text: str) -> list[float]: ...

    async def embed_passages(self, passages: list[str]) -> list[list[float]]:
        """Batch-embed many passages. The ``embed_writer`` job calls this in
        batches of 32 to populate ``Chunk.embedding`` rows after ingest."""
        ...


class DenseRetriever(Protocol):
    """ANN over chunk embeddings. pgvector HNSW in production."""

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
    ) -> list[Candidate]: ...


class SparseRetriever(Protocol):
    """BM25-style ranking over ``Chunk.tsv``."""

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
    ) -> list[Candidate]: ...


class Reranker(Protocol):
    """Joint (query, content) scorer. BGE-Reranker in production."""

    async def rerank(
        self,
        *,
        query: str,
        chunks: list[RetrievedChunk],
        top_k: int,
    ) -> list[RetrievedChunk]: ...


class ChunkResolver(Protocol):
    """Turns a list of chunk ids into full ``RetrievedChunk``s. In production
    this is a single SQL fetch from Postgres; in tests it's a dict lookup."""

    async def hydrate(self, chunk_ids: list[str]) -> list[RetrievedChunk]: ...


class RetrievalCache(Protocol):
    async def get_exact(self, key: str) -> RetrievalResult | None: ...
    async def put_exact(self, key: str, result: RetrievalResult) -> None: ...
    async def get_semantic(
        self, *, embedding: list[float], tenant_id: str, course_id: str | None
    ) -> RetrievalResult | None: ...
    async def put_semantic(
        self,
        *,
        embedding: list[float],
        tenant_id: str,
        course_id: str | None,
        result: RetrievalResult,
    ) -> None: ...


# ─────────────────────────────────────────────────────────────────────────────
# Orchestrator
# ─────────────────────────────────────────────────────────────────────────────


class Retriever:
    """One ``retrieve`` entrypoint. Agents and the search endpoint consume this."""

    def __init__(
        self,
        *,
        embedder: Embedder,
        dense: DenseRetriever,
        sparse: SparseRetriever,
        reranker: Reranker,
        resolver: ChunkResolver,
        cache: RetrievalCache | None = None,
    ) -> None:
        self._embedder = embedder
        self._dense = dense
        self._sparse = sparse
        self._reranker = reranker
        self._resolver = resolver
        self._cache = cache

    async def retrieve(self, req: RetrievalRequest) -> RetrievalResult:
        telemetry = RetrievalTelemetry()
        started = time.perf_counter()

        # 1. Exact-match cache.
        exact_key = self._exact_key(req)
        if self._cache is not None:
            cached = await self._cache.get_exact(exact_key)
            if cached is not None:
                cached.telemetry.exact_cache_hit = True
                cached.telemetry.total_latency_ms = self._elapsed_ms(started)
                return cached

        # 2. Embed query (needed by dense + semantic cache).
        embedding = await self._embedder.embed_query(req.query)

        # 3. Semantic cache.
        if self._cache is not None:
            cached = await self._cache.get_semantic(
                embedding=embedding,
                tenant_id=req.tenant_id,
                course_id=req.course_id,
            )
            if cached is not None:
                cached.telemetry.semantic_cache_hit = True
                cached.telemetry.total_latency_ms = self._elapsed_ms(started)
                return cached

        # 4. Hybrid retrieval. Dense + sparse run concurrently in production;
        #    sequential here keeps the orchestrator pure-async-aware without
        #    pulling in a task group dependency.
        dense_started = time.perf_counter()
        dense_candidates = await self._dense.search(
            embedding=embedding,
            tenant_id=req.tenant_id,
            course_id=req.course_id,
            folder_id=req.folder_id,
            k=req.candidates_per_retriever,
            metadata_filter=req.metadata_filter,
            chapters=req.chapters,
        )
        telemetry.dense_candidates = len(dense_candidates)
        telemetry.dense_latency_ms = self._elapsed_ms(dense_started)

        sparse_started = time.perf_counter()
        sparse_candidates = await self._sparse.search(
            query=req.query,
            tenant_id=req.tenant_id,
            course_id=req.course_id,
            folder_id=req.folder_id,
            k=req.candidates_per_retriever,
            metadata_filter=req.metadata_filter,
            chapters=req.chapters,
        )
        telemetry.sparse_candidates = len(sparse_candidates)
        telemetry.sparse_latency_ms = self._elapsed_ms(sparse_started)

        # 5. RRF fusion. Rank-only; scores discarded.
        fused = reciprocal_rank_fusion(
            rankings=[dense_candidates, sparse_candidates],
            k=req.fusion_k,
        )
        telemetry.fused_candidates = len(fused)

        if not fused:
            return RetrievalResult(
                chunks=[],
                telemetry=self._finalise_telemetry(telemetry, started),
                diagnostics={"reason": "no candidates from dense or sparse"},
            )

        # 6. Hydrate chunk bodies (single SQL fetch in production).
        hydrated = await self._resolver.hydrate([c.chunk_id for c in fused])
        by_id = {chunk.chunk_id: chunk for chunk in hydrated}
        # Normalise fused RRF scores to [0, 1] so downstream support
        # filtering has a meaningful signal. Raw RRF scores are tiny
        # (~1/(60+rank)); without normalisation every chunk lands well
        # below the agent's support threshold.
        max_fused = max((c.score for c in fused), default=0.0) or 1.0
        normalised_scores = {c.chunk_id: c.score / max_fused for c in fused}
        # Preserve fused order for the reranker input, carrying scores forward.
        rerank_input = [
            by_id[c.chunk_id].model_copy(
                update={"score": normalised_scores.get(c.chunk_id, 0.0)}
            )
            for c in fused
            if c.chunk_id in by_id
        ]

        # 7. Rerank.
        rerank_started = time.perf_counter()
        reranked = await self._reranker.rerank(
            query=req.query, chunks=rerank_input, top_k=req.k
        )
        telemetry.rerank_latency_ms = self._elapsed_ms(rerank_started)
        telemetry.reranked_returned = len(reranked)

        result = RetrievalResult(
            chunks=reranked,
            telemetry=self._finalise_telemetry(telemetry, started),
        )

        # 8. Write-through caches.
        if self._cache is not None:
            await self._cache.put_exact(exact_key, result)
            await self._cache.put_semantic(
                embedding=embedding,
                tenant_id=req.tenant_id,
                course_id=req.course_id,
                result=result,
            )

        return result

    # ── helpers ──────────────────────────────────────────────────────────────

    @staticmethod
    def _exact_key(req: RetrievalRequest) -> str:
        import hashlib

        normalised = " ".join(req.query.lower().split())
        h = hashlib.sha256()
        h.update(req.tenant_id.encode())
        h.update(b"|")
        h.update((req.course_id or "-").encode())
        h.update(b"|")
        h.update(normalised.encode())
        h.update(b"|")
        h.update(str(req.k).encode())
        return h.hexdigest()

    @staticmethod
    def _elapsed_ms(started: float) -> int:
        return int((time.perf_counter() - started) * 1000)

    def _finalise_telemetry(
        self, telemetry: RetrievalTelemetry, started: float
    ) -> RetrievalTelemetry:
        telemetry.total_latency_ms = self._elapsed_ms(started)
        return telemetry


__all__ = [
    "Candidate",
    "ChunkResolver",
    "DenseRetriever",
    "Embedder",
    "MetadataFilter",
    "Reranker",
    "Retriever",
    "RetrievalCache",
    "RetrievalRequest",
    "RetrievalResult",
    "RetrievalTelemetry",
    "RetrievedChunk",
    "RetrieverKind",
]
