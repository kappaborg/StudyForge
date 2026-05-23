"""Reranker implementations.

The ``Reranker`` Protocol lives in ``retriever.py``. Two shipped in Phase 1:

  * ``IdentityReranker`` — returns the top-k of the input unchanged. Used by
    tests and the Phase-1 thin slice. Determinism is the point.
  * ``BgeReranker`` — wraps the ``BAAI/bge-reranker-large`` cross-encoder.
    Lazy-loads the model on first use. Phase 1 mid.
"""

from __future__ import annotations

import logging

from .contracts import RetrievedChunk

log = logging.getLogger(__name__)


class IdentityReranker:
    """No-op reranker — returns the first ``top_k`` chunks in input order.

    The retrieval orchestrator passes the RRF-fused ranking as input, so
    using this preserves the fused order. Phase 1 mid swaps this for the
    BGE cross-encoder which rescues recall on hard queries.
    """

    async def rerank(
        self,
        *,
        query: str,
        chunks: list[RetrievedChunk],
        top_k: int,
    ) -> list[RetrievedChunk]:
        return chunks[:top_k]


# ─────────────────────────────────────────────────────────────────────────────
# BGE-Reranker (Phase 1 mid)
# ─────────────────────────────────────────────────────────────────────────────


class BgeReranker:
    """Cross-encoder reranker. Heavy dependency — loaded lazily."""

    def __init__(self, model_name: str = "BAAI/bge-reranker-large") -> None:
        self._model_name = model_name
        self._model: object | None = None

    def _load(self) -> object:
        if self._model is None:
            try:
                from sentence_transformers import CrossEncoder
            except ImportError as exc:  # pragma: no cover
                raise RuntimeError(
                    "BgeReranker requires `sentence-transformers`. "
                    "Install with: uv pip install sentence-transformers"
                ) from exc
            log.info("loading BGE-Reranker (%s) — first call only", self._model_name)
            self._model = CrossEncoder(self._model_name)
        return self._model

    async def rerank(
        self,
        *,
        query: str,
        chunks: list[RetrievedChunk],
        top_k: int,
    ) -> list[RetrievedChunk]:  # pragma: no cover — heavy
        if not chunks:
            return []
        model = self._load()
        pairs = [(query, c.content) for c in chunks]
        scores = model.predict(pairs)  # type: ignore[attr-defined]
        scored = sorted(
            zip(chunks, (float(s) for s in scores), strict=True),
            key=lambda pair: pair[1],
            reverse=True,
        )
        # Rewrite the chunk score with the reranker score so downstream code
        # sees the most-informative number on the citation.
        return [
            chunk.model_copy(update={"score": _clip01(score)})
            for chunk, score in scored[:top_k]
        ]


def _clip01(x: float) -> float:
    return 0.0 if x < 0.0 else 1.0 if x > 1.0 else x
