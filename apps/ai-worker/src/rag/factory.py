"""Single chokepoint for building the embedder + retriever.

Every HTTP route and the ingest agent reads from here so the embedder
backend is swapped consistently. ``EMBEDDER_BACKEND=fastembed`` in the
worker's .env upgrades retrieval from sparse-only to true semantic.
"""

from __future__ import annotations

from typing import Any

from ..settings import Settings
from .embedder import FastEmbedEmbedder, StubEmbedder
from .retriever import Embedder


def build_embedder(settings: Settings) -> Embedder:
    backend = (settings.embedder_backend or "stub").lower()
    if backend == "fastembed":
        return FastEmbedEmbedder()
    return StubEmbedder()


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
