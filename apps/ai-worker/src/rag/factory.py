"""Single chokepoint for building the embedder + retriever.

Every HTTP route and the ingest agent reads from here so the embedder
backend is swapped consistently. ``EMBEDDER_BACKEND=fastembed`` in the
worker's .env upgrades retrieval from sparse-only to true semantic.

``RERANKER_BACKEND`` selects the reranker: ``cross`` (default) loads the
sentence-transformers cross-encoder lazily on first query; anything else
falls back to the identity (no-op) reranker. ``RERANKER_MODEL`` lets the
operator pick a specific cross-encoder; defaults to MiniLM-L-6-v2.
"""

from __future__ import annotations

import os
from typing import Any

from ..settings import Settings
from .embedder import FastEmbedEmbedder, StubEmbedder
from .reranker import CrossEncoderReranker, IdentityReranker
from .retriever import Embedder, Reranker


def build_embedder(settings: Settings) -> Embedder:
    backend = (settings.embedder_backend or "stub").lower()
    if backend == "fastembed":
        return FastEmbedEmbedder()
    return StubEmbedder()


def build_reranker(_settings: Settings | None = None) -> Reranker:
    """Cross-encoder by default; identity when explicitly disabled.

    The cross-encoder is lazy — boot stays fast; the model loads only when
    the first real query hits the rerank step. Load failures degrade
    gracefully to identity (see CrossEncoderReranker._load).
    """
    backend = os.environ.get("RERANKER_BACKEND", "cross").lower()
    if backend in {"identity", "none", "off", "stub"}:
        return IdentityReranker()
    model = os.environ.get("RERANKER_MODEL", CrossEncoderReranker.DEFAULT_MODEL)
    return CrossEncoderReranker(model)


def is_stub_embedder(embedder: Embedder) -> bool:
    """Routes use this to decide whether to bypass dense retrieval. The
    stub's vectors are hash-based — running ANN against them returns
    effectively random results, so we skip dense and let sparse drive
    the ranking."""
    return isinstance(embedder, StubEmbedder)


def _build_no_op_dense() -> Any:
    """Stand-in dense retriever for the stub embedder path."""

    class _NoOpDense:
        async def search(self, **_: object) -> list[Any]:
            return []

    return _NoOpDense()
