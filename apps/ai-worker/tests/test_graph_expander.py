"""KG expander — one-hop ranking for thin retrieval results."""

from __future__ import annotations

from src.agents.contracts import ConceptEdge, ConceptEdgeKind
from src.graph.expander import expand_one_hop


def _e(src: str, dst: str, kind: ConceptEdgeKind, weight: float = 1.0) -> ConceptEdge:
    return ConceptEdge(from_id=src, to_id=dst, kind=kind, weight=weight)


def test_expander_returns_empty_when_no_seeds() -> None:
    assert expand_one_hop(seed_concept_ids=[], edges=[]) == []


def test_expander_surfaces_examples_before_related_before_prereqs() -> None:
    edges = [
        # ex_a is an example of seed.
        _e("ex_a", "seed", ConceptEdgeKind.example_of),
        # rel_b is related_to seed (symmetric).
        _e("seed", "rel_b", ConceptEdgeKind.related_to),
        # prereq_c is a prereq of seed (walked target-side from seed direction).
        _e("seed", "prereq_c", ConceptEdgeKind.prerequisite_of),
    ]
    out = expand_one_hop(seed_concept_ids=["seed"], edges=edges)
    assert out == ["ex_a", "rel_b", "prereq_c"]


def test_expander_excludes_contradicts_by_default() -> None:
    edges = [_e("seed", "opp", ConceptEdgeKind.contradicts)]
    assert expand_one_hop(seed_concept_ids=["seed"], edges=edges) == []
    assert expand_one_hop(
        seed_concept_ids=["seed"], edges=edges, include_contradicts=True
    ) == ["opp"]


def test_expander_does_not_return_seed_nodes() -> None:
    edges = [_e("seed1", "seed2", ConceptEdgeKind.related_to)]
    assert expand_one_hop(seed_concept_ids=["seed1", "seed2"], edges=edges) == []


def test_expander_breaks_ties_alphabetically() -> None:
    edges = [
        _e("z", "seed", ConceptEdgeKind.example_of, weight=0.5),
        _e("a", "seed", ConceptEdgeKind.example_of, weight=0.5),
        _e("m", "seed", ConceptEdgeKind.example_of, weight=0.5),
    ]
    out = expand_one_hop(seed_concept_ids=["seed"], edges=edges)
    assert out == ["a", "m", "z"]


def test_expander_prefers_higher_weight_within_same_kind() -> None:
    edges = [
        _e("low", "seed", ConceptEdgeKind.example_of, weight=0.1),
        _e("high", "seed", ConceptEdgeKind.example_of, weight=0.9),
    ]
    out = expand_one_hop(seed_concept_ids=["seed"], edges=edges)
    assert out == ["high", "low"]


def test_expander_respects_max_results() -> None:
    edges = [
        _e(f"n{i}", "seed", ConceptEdgeKind.example_of, weight=0.5)
        for i in range(10)
    ]
    out = expand_one_hop(seed_concept_ids=["seed"], edges=edges, max_results=3)
    assert len(out) == 3
