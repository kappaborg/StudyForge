"""KG one-hop expansion for the RAG retriever.

When reranking returns ≤ 2 chunks above the support threshold, the retriever
asks the graph layer for related concepts. We walk one hop from each seed
concept and return concept ids ranked by edge-kind priority and weight.

This is read-only by design — any new associations discovered at query time
are not persisted.
"""

from __future__ import annotations

from collections import defaultdict

from ..agents.contracts import ConceptEdge, ConceptEdgeKind

# Lower number = higher priority. See docs/architecture/07-knowledge-graph.md.
_KIND_PRIORITY: dict[ConceptEdgeKind, int] = {
    ConceptEdgeKind.example_of: 1,
    ConceptEdgeKind.related_to: 2,
    ConceptEdgeKind.prerequisite_of: 3,
    ConceptEdgeKind.derived_from: 4,
    ConceptEdgeKind.contradicts: 5,
}

# Set of edge kinds the expander treats as symmetric. Direction is ignored
# for these — walking from either endpoint surfaces the other.
_SYMMETRIC: frozenset[ConceptEdgeKind] = frozenset(
    {ConceptEdgeKind.related_to, ConceptEdgeKind.contradicts}
)


def expand_one_hop(
    *,
    seed_concept_ids: list[str],
    edges: list[ConceptEdge],
    max_results: int = 8,
    include_contradicts: bool = False,
) -> list[str]:
    """Return concept ids one hop from any seed, ranked best-first.

    Ranking is by (lowest kind priority, highest weight, lowest concept id) so
    two runs over the same graph and same seeds produce byte-identical output.

    ``include_contradicts`` is False by default; callers flip it on only when
    the original user query explicitly asks for contrast (see §7).
    """
    if not seed_concept_ids:
        return []

    seeds = set(seed_concept_ids)

    # neighbour_id -> best (priority, -weight, neighbour_id) seen
    best_by_neighbour: dict[str, tuple[int, float, str]] = defaultdict(
        lambda: (10**9, 0.0, "")
    )

    for edge in edges:
        if not include_contradicts and edge.kind is ConceptEdgeKind.contradicts:
            continue
        priority = _KIND_PRIORITY[edge.kind]

        from_in_seeds = edge.from_id in seeds
        to_in_seeds = edge.to_id in seeds

        # Direction policy:
        #   symmetric: both endpoints surface the other
        #   prerequisite_of, derived_from: walking from source surfaces target
        #   example_of: walking from target surfaces source (canonical: X example_of Y)
        if edge.kind in _SYMMETRIC:
            for src, dst in ((edge.from_id, edge.to_id), (edge.to_id, edge.from_id)):
                if src in seeds and dst not in seeds:
                    _consider(best_by_neighbour, dst, priority, edge.weight)
        elif edge.kind is ConceptEdgeKind.example_of:
            if to_in_seeds and not from_in_seeds:
                _consider(best_by_neighbour, edge.from_id, priority, edge.weight)
        else:  # prerequisite_of, derived_from
            if from_in_seeds and not to_in_seeds:
                _consider(best_by_neighbour, edge.to_id, priority, edge.weight)

    ranked = sorted(
        best_by_neighbour.items(),
        key=lambda item: (item[1][0], item[1][1], item[0]),
    )
    return [neighbour_id for neighbour_id, _ in ranked[:max_results]]


def _consider(
    best: dict[str, tuple[int, float, str]],
    neighbour_id: str,
    priority: int,
    weight: float,
) -> None:
    current = best[neighbour_id]
    candidate = (priority, -weight, neighbour_id)
    if candidate < current:
        best[neighbour_id] = candidate
