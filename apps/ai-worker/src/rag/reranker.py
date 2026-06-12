"""Reranker implementations.

The ``Reranker`` Protocol lives in ``retriever.py``. Two shipped:

  * ``IdentityReranker`` — returns the top-k of the input unchanged. Used by
    tests and as a safe fallback when the cross-encoder fails to load.
    Determinism is the point.
  * ``CrossEncoderReranker`` — wraps a sentence-transformers cross-encoder.
    Defaults to ``cross-encoder/ms-marco-MiniLM-L-6-v2`` (~80 MB), which is
    the cheapest model with materially better recall@k than RRF-alone on
    Q&A queries. Swap via ``RERANKER_MODEL`` env var to ``BAAI/bge-reranker-base``
    (~280 MB) when retrieval quality starts dominating user complaints.
"""

from __future__ import annotations

import asyncio
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


class CrossEncoderReranker:
    """sentence-transformers cross-encoder reranker.

    Designed to fail open: if the model can't be loaded (no network for the
    first download, missing dep, OOM on a tiny worker), ``rerank`` returns
    the input order rather than raising. Retrieval keeps working — citations
    just get the RRF-fused score instead of the cross-encoder's score. The
    failure is logged once.

    Default model is ``cross-encoder/ms-marco-MiniLM-L-6-v2`` (~80 MB,
    very fast on CPU). Override via the ``RERANKER_MODEL`` env var.
    """

    DEFAULT_MODEL = "cross-encoder/ms-marco-MiniLM-L-6-v2"

    def __init__(self, model_name: str = DEFAULT_MODEL) -> None:
        self._model_name = model_name
        self._model: object | None = None
        self._load_failed = False

    def _load(self) -> object | None:
        if self._model is not None:
            return self._model
        if self._load_failed:
            return None
        try:
            from sentence_transformers import CrossEncoder

            log.info("reranker.loading model=%s (first call only)", self._model_name)
            self._model = CrossEncoder(self._model_name)
            return self._model
        except Exception as exc:
            # Network down on first run, missing dep, or model file corrupt.
            # We disable for the lifetime of the process to avoid retrying on
            # every query; restart picks it back up.
            self._load_failed = True
            log.warning(
                "reranker.load_failed model=%s err=%s — falling back to identity",
                self._model_name,
                exc,
            )
            return None

    async def rerank(
        self,
        *,
        query: str,
        chunks: list[RetrievedChunk],
        top_k: int,
    ) -> list[RetrievedChunk]:
        if not chunks:
            return []
        model = self._load()
        if model is None:
            # Fail-open path: preserve the fused order.
            return chunks[:top_k]
        pairs = [(query, c.content) for c in chunks]
        # ``predict`` is sync and CPU-bound; offload so we don't block the
        # event loop for the 50–200ms a small batch typically takes.
        try:
            scores = await asyncio.to_thread(model.predict, pairs)  # type: ignore[attr-defined]
        except Exception as exc:
            log.warning("reranker.predict_failed err=%s — falling back to identity", exc)
            return chunks[:top_k]
        scored = sorted(
            zip(chunks, (float(s) for s in scores), strict=True),
            key=lambda pair: pair[1],
            reverse=True,
        )
        # Rewrite the chunk score with the (normalised) reranker score so
        # downstream code (citations, telemetry) sees the most-informative
        # number. Different cross-encoders emit scores on different scales
        # (some logits, some sigmoid); we map via a soft squash to [0, 1].
        return [
            chunk.model_copy(update={"score": _sigmoid(score)})
            for chunk, score in scored[:top_k]
        ]


# Back-compat alias — old call sites and tests may still reference BgeReranker.
BgeReranker = CrossEncoderReranker


def _sigmoid(x: float) -> float:
    # math.exp blows up for large negative numbers; clamp to keep the
    # numbers stable on weird models that emit raw logits.
    import math

    if x > 30:
        return 1.0
    if x < -30:
        return 0.0
    return 1.0 / (1.0 + math.exp(-x))


def _clip01(x: float) -> float:
    return 0.0 if x < 0.0 else 1.0 if x > 1.0 else x
