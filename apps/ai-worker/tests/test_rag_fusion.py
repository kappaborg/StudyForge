"""Reciprocal Rank Fusion — must be deterministic across runs.

The eval harness asserts on byte-identical RRF output to detect retrieval-policy
regressions. These tests are the canary.
"""

from __future__ import annotations

from src.rag.contracts import Candidate, RetrieverKind
from src.rag.fusion import reciprocal_rank_fusion


def _candidates(kind: RetrieverKind, ids: list[str]) -> list[Candidate]:
    return [Candidate(chunk_id=i, rank=r, score=1.0 - r * 0.1, kind=kind) for r, i in enumerate(ids)]


def test_rrf_returns_empty_when_no_rankings() -> None:
    assert reciprocal_rank_fusion(rankings=[]) == []


def test_rrf_returns_empty_when_all_rankings_empty() -> None:
    assert reciprocal_rank_fusion(rankings=[[], []]) == []


def test_rrf_assigns_higher_score_to_candidates_appearing_in_both() -> None:
    dense = _candidates(RetrieverKind.dense, ["a", "b", "c"])
    sparse = _candidates(RetrieverKind.sparse, ["b", "d", "c"])
    out = reciprocal_rank_fusion(rankings=[dense, sparse], k=60)
    # b appears at ranks 1 and 0 → highest fused score.
    # c appears at ranks 2 and 2.
    # a and d each appear once.
    assert out[0].chunk_id == "b"
    assert {out[1].chunk_id, out[2].chunk_id} == {"a", "c"}
    assert out[3].chunk_id == "d"
    assert out[0].rank == 0 and out[3].rank == 3


def test_rrf_is_deterministic_for_tied_scores() -> None:
    # Identical rankings produce ties on every candidate; tie-break MUST be
    # alphabetical by chunk_id so eval golden sets stay reproducible.
    dense = _candidates(RetrieverKind.dense, ["c", "a", "b"])
    sparse = _candidates(RetrieverKind.sparse, ["c", "a", "b"])
    out = reciprocal_rank_fusion(rankings=[dense, sparse])
    assert [c.chunk_id for c in out] == ["c", "a", "b"]
    # Second run produces byte-identical output.
    again = reciprocal_rank_fusion(rankings=[dense, sparse])
    assert [c.chunk_id for c in again] == [c.chunk_id for c in out]
    assert [c.score for c in again] == [c.score for c in out]


def test_rrf_rejects_invalid_k() -> None:
    import pytest

    with pytest.raises(ValueError):
        reciprocal_rank_fusion(rankings=[[]], k=0)
