"""Reciprocal Rank Fusion.

Rank-only fusion: scores from dense and sparse are intentionally discarded
because they live on incomparable scales. Determinism is mandatory — every
test in the RAG suite asserts on byte-identical ordering across runs.
"""

from __future__ import annotations

from collections.abc import Iterable

from .contracts import Candidate


def reciprocal_rank_fusion(
    *,
    rankings: Iterable[list[Candidate]],
    k: int = 60,
) -> list[Candidate]:
    """Fuse multiple ranked lists into a single ranking.

    Implements ``RRF_score(c) = Σ_r 1 / (k + rank_r(c))``. Returns candidates
    sorted by fused score descending. Ties are broken by ``chunk_id`` to keep
    the output deterministic — required by the eval harness.

    Each candidate's ``score`` on the output is the fused RRF score; the
    ``kind`` is set to the source that first produced it (recoverable from
    diagnostics if needed) and the ``rank`` is the fused rank starting at 0.
    """
    if k < 1:
        raise ValueError("k must be >= 1")

    scores: dict[str, float] = {}
    first_source: dict[str, Candidate] = {}

    for ranking in rankings:
        for rank, candidate in enumerate(ranking):
            scores[candidate.chunk_id] = scores.get(candidate.chunk_id, 0.0) + 1.0 / (
                k + rank + 1
            )
            first_source.setdefault(candidate.chunk_id, candidate)

    sorted_ids = sorted(
        scores.items(),
        key=lambda pair: (-pair[1], pair[0]),
    )

    fused: list[Candidate] = []
    for new_rank, (chunk_id, score) in enumerate(sorted_ids):
        original = first_source[chunk_id]
        fused.append(
            Candidate(
                chunk_id=chunk_id,
                rank=new_rank,
                score=round(score, 12),
                kind=original.kind,
            )
        )
    return fused
