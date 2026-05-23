"""Cytoscape JSON spec generator.

Denormalised projection of ``Concept`` + ``ConceptEdge`` rows that the FE
renders directly. Server-side layout is embedded only for small graphs
(≤ ``EMBED_POSITIONS_BELOW`` nodes); larger graphs ship topology only and the
FE lays them out client-side.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from math import cos, pi, sin
from typing import Any

from ..agents.contracts import Concept, ConceptEdge

EMBED_POSITIONS_BELOW = 200


@dataclass
class CytoscapeSpec:
    """Wire-format-friendly container. Use ``to_dict()`` for serialisation."""

    elements: list[dict[str, Any]] = field(default_factory=list)
    meta: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {"elements": self.elements, "meta": self.meta}


def to_cytoscape(
    concepts: list[Concept],
    edges: list[ConceptEdge],
) -> CytoscapeSpec:
    """Build the Cytoscape spec. Deterministic — same input, same output."""
    sorted_concepts = sorted(concepts, key=lambda c: c.id)
    sorted_edges = sorted(edges, key=lambda e: (e.from_id, e.to_id, e.kind.value))

    embed_positions = len(sorted_concepts) <= EMBED_POSITIONS_BELOW
    elements: list[dict[str, Any]] = []

    for index, concept in enumerate(sorted_concepts):
        node: dict[str, Any] = {
            "data": {
                "id": concept.id,
                "label": concept.label,
                "difficulty": concept.difficulty,
                "kind": "concept",
                "blockRefs": list(concept.block_refs),
            }
        }
        if embed_positions:
            node["position"] = _circle_position(index, len(sorted_concepts))
        elements.append(node)

    for index, edge in enumerate(sorted_edges):
        elements.append(
            {
                "data": {
                    "id": f"e-{index}",
                    "source": edge.from_id,
                    "target": edge.to_id,
                    "kind": edge.kind.value,
                    "weight": edge.weight,
                    "kindPriority": _kind_priority(edge.kind.value),
                }
            }
        )

    return CytoscapeSpec(
        elements=elements,
        meta={
            "nodeCount": len(sorted_concepts),
            "edgeCount": len(sorted_edges),
            "isLayoutEmbedded": embed_positions,
        },
    )


def _circle_position(index: int, total: int) -> dict[str, float]:
    """Place nodes on a circle for the embedded-layout case. The FE replaces
    this with force-directed layout on user interaction — we only ship a sane
    initial position so the first paint is not a pile-of-circles."""
    if total <= 0:
        return {"x": 0.0, "y": 0.0}
    radius = 320.0
    angle = (2 * pi * index) / total
    return {"x": round(radius * cos(angle), 2), "y": round(radius * sin(angle), 2)}


def _kind_priority(kind: str) -> int:
    return {
        "example_of": 1,
        "related_to": 2,
        "prerequisite_of": 3,
        "derived_from": 4,
        "contradicts": 5,
    }.get(kind, 9)
