"""Graph algorithms — DAG validation, deterministic topo sort, prereq walk,
effective-difficulty propagation."""

from __future__ import annotations

import pytest

from src.agents.contracts import Concept, ConceptEdge, ConceptEdgeKind
from src.graph.algorithms import (
    CycleFoundError,
    effective_difficulty,
    prerequisites_of,
    topological_order,
    validate_dag,
)


def _c(cid: str, label: str | None = None, difficulty: int = 0) -> Concept:
    return Concept(id=cid, label=label or cid, difficulty=difficulty, block_refs=[0])


def _e(src: str, dst: str, kind: ConceptEdgeKind, weight: float = 1.0) -> ConceptEdge:
    return ConceptEdge(from_id=src, to_id=dst, kind=kind, weight=weight)


def test_validate_dag_passes_for_simple_acyclic_graph() -> None:
    concepts = [_c("a"), _c("b"), _c("c")]
    edges = [
        _e("a", "b", ConceptEdgeKind.prerequisite_of),
        _e("b", "c", ConceptEdgeKind.prerequisite_of),
    ]
    assert validate_dag(concepts, edges) == []


def test_validate_dag_reports_cycle_path() -> None:
    concepts = [_c("a"), _c("b"), _c("c")]
    edges = [
        _e("a", "b", ConceptEdgeKind.prerequisite_of),
        _e("b", "c", ConceptEdgeKind.prerequisite_of),
        _e("c", "a", ConceptEdgeKind.prerequisite_of),
    ]
    cycle = validate_dag(concepts, edges)
    assert cycle, "expected cycle to be detected"
    # Path starts and ends with the same node — the cycle's closing edge.
    assert cycle[0] == cycle[-1]
    assert set(cycle) == {"a", "b", "c"}


def test_validate_dag_ignores_symmetric_edge_kinds() -> None:
    # related_to is symmetric — even though it loops syntactically, the
    # validator should not flag it.
    concepts = [_c("a"), _c("b")]
    edges = [
        _e("a", "b", ConceptEdgeKind.related_to),
        _e("b", "a", ConceptEdgeKind.related_to),
    ]
    assert validate_dag(concepts, edges) == []


def test_topological_order_is_dependency_first() -> None:
    concepts = [_c("a"), _c("b"), _c("c"), _c("d")]
    edges = [
        _e("a", "c", ConceptEdgeKind.prerequisite_of),
        _e("b", "c", ConceptEdgeKind.prerequisite_of),
        _e("c", "d", ConceptEdgeKind.prerequisite_of),
    ]
    order = topological_order(concepts, edges)
    assert order.index("a") < order.index("c")
    assert order.index("b") < order.index("c")
    assert order.index("c") < order.index("d")


def test_topological_order_is_deterministic_with_alphabetical_tiebreak() -> None:
    # Three independent leaves: c, b, a. Topo sort must emit them
    # alphabetically regardless of insertion order in the input list.
    concepts = [_c("c"), _c("b"), _c("a")]
    edges: list[ConceptEdge] = []
    assert topological_order(concepts, edges) == ["a", "b", "c"]


def test_topological_order_raises_on_cycle() -> None:
    concepts = [_c("a"), _c("b")]
    edges = [
        _e("a", "b", ConceptEdgeKind.prerequisite_of),
        _e("b", "a", ConceptEdgeKind.prerequisite_of),
    ]
    with pytest.raises(CycleFoundError) as exc_info:
        topological_order(concepts, edges)
    assert exc_info.value.cycle, "cycle path must be attached"


def test_prerequisites_of_returns_transitive_ancestors_closest_first() -> None:
    edges = [
        _e("a", "b", ConceptEdgeKind.prerequisite_of),
        _e("b", "c", ConceptEdgeKind.prerequisite_of),
        _e("d", "c", ConceptEdgeKind.prerequisite_of),
    ]
    out = prerequisites_of("c", edges)
    # Direct prereqs come first (BFS order); a is reachable transitively.
    assert out[:2] == ["b", "d"]
    assert "a" in out


def test_prerequisites_of_returns_empty_when_target_has_none() -> None:
    edges = [_e("a", "b", ConceptEdgeKind.related_to)]
    assert prerequisites_of("a", edges) == []


def test_effective_difficulty_takes_max_of_self_and_ancestors() -> None:
    concepts = [
        _c("a", difficulty=10),
        _c("b", difficulty=20),
        _c("c", difficulty=5),  # weak own difficulty but inherits from a + b
    ]
    edges = [
        _e("a", "c", ConceptEdgeKind.prerequisite_of),
        _e("b", "c", ConceptEdgeKind.prerequisite_of),
    ]
    eff = effective_difficulty(concepts, edges)
    assert eff["a"] == 10
    assert eff["b"] == 20
    assert eff["c"] == 20  # max(5, 10, 20)
