"""Cytoscape spec generator — deterministic, layout-conditional."""

from __future__ import annotations

from src.agents.contracts import Concept, ConceptEdge, ConceptEdgeKind
from src.graph.cytoscape import EMBED_POSITIONS_BELOW, to_cytoscape


def _c(cid: str, label: str | None = None, difficulty: int = 0) -> Concept:
    return Concept(id=cid, label=label or cid, difficulty=difficulty, block_refs=[0])


def _e(src: str, dst: str, kind: ConceptEdgeKind) -> ConceptEdge:
    return ConceptEdge(from_id=src, to_id=dst, kind=kind)


def test_cytoscape_emits_one_element_per_concept_and_edge() -> None:
    concepts = [_c("a"), _c("b"), _c("c")]
    edges = [
        _e("a", "b", ConceptEdgeKind.prerequisite_of),
        _e("b", "c", ConceptEdgeKind.related_to),
    ]
    spec = to_cytoscape(concepts, edges)
    assert spec.meta == {"nodeCount": 3, "edgeCount": 2, "isLayoutEmbedded": True}
    assert len(spec.elements) == 5

    node_ids = [el["data"]["id"] for el in spec.elements if "source" not in el["data"]]
    edge_kinds = [el["data"]["kind"] for el in spec.elements if "source" in el["data"]]
    assert node_ids == ["a", "b", "c"]
    assert edge_kinds == ["prerequisite_of", "related_to"]


def test_cytoscape_embeds_positions_only_for_small_graphs() -> None:
    concepts = [_c("a"), _c("b")]
    spec = to_cytoscape(concepts, [])
    for el in spec.elements:
        if "source" not in el["data"]:
            assert "position" in el and {"x", "y"} <= el["position"].keys()


def test_cytoscape_omits_positions_for_large_graphs() -> None:
    concepts = [_c(f"c{i:04d}") for i in range(EMBED_POSITIONS_BELOW + 1)]
    spec = to_cytoscape(concepts, [])
    assert spec.meta["isLayoutEmbedded"] is False
    nodes = [el for el in spec.elements if "source" not in el["data"]]
    assert all("position" not in el for el in nodes)


def test_cytoscape_is_deterministic_across_runs() -> None:
    concepts = [_c("z"), _c("a"), _c("m")]
    edges = [
        _e("z", "a", ConceptEdgeKind.prerequisite_of),
        _e("a", "m", ConceptEdgeKind.related_to),
    ]
    first = to_cytoscape(concepts, edges).to_dict()
    second = to_cytoscape(concepts, edges).to_dict()
    assert first == second
    # Nodes are sorted by id so two clients hit the same cache key.
    node_ids = [
        el["data"]["id"] for el in first["elements"] if "source" not in el["data"]
    ]
    assert node_ids == sorted(node_ids)
