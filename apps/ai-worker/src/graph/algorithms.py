"""Pure graph algorithms.

The four load-bearing operations: cycle detection, deterministic topological
sort, prerequisite walk, and effective-difficulty propagation. All are
O(V + E) — operate over the in-memory Pydantic ``Concept`` / ``ConceptEdge``
contracts. Storage retrieval happens elsewhere.
"""

from __future__ import annotations

from collections import defaultdict, deque
from collections.abc import Iterator

from ..agents.contracts import Concept, ConceptEdge, ConceptEdgeKind

# ─────────────────────────────────────────────────────────────────────────────
# Cycle detection
# ─────────────────────────────────────────────────────────────────────────────


class CycleFoundError(ValueError):
    """Raised when an algorithm that requires acyclicity is given a graph with
    a cycle. The cycle path is attached so callers can surface it."""

    def __init__(self, cycle: list[str]) -> None:
        super().__init__(f"cycle detected: {' -> '.join(cycle)}")
        self.cycle = cycle


def validate_dag(concepts: list[Concept], edges: list[ConceptEdge]) -> list[str]:
    """Return the first cycle found as a concept-id path, or ``[]`` if acyclic.

    Considers only ``prerequisite_of`` and ``derived_from`` edges — the
    directional kinds. Symmetric kinds (``related_to``, ``contradicts``) cannot
    by themselves produce a cycle in a topological sense.
    """
    adjacency = _directed_adjacency(concepts, edges)
    WHITE, GRAY, BLACK = 0, 1, 2
    colour: dict[str, int] = defaultdict(lambda: WHITE)
    parent: dict[str, str | None] = {}

    def walk(start: str) -> list[str]:
        stack: list[tuple[str, Iterator[str]]] = [(start, iter(adjacency[start]))]
        colour[start] = GRAY
        parent[start] = None
        while stack:
            node, neighbours = stack[-1]
            next_neighbour = next(neighbours, None)
            if next_neighbour is None:
                colour[node] = BLACK
                stack.pop()
                continue
            if colour[next_neighbour] == WHITE:
                colour[next_neighbour] = GRAY
                parent[next_neighbour] = node
                stack.append((next_neighbour, iter(adjacency[next_neighbour])))
                continue
            if colour[next_neighbour] == GRAY:
                return _reconstruct_cycle(parent, node, next_neighbour)
        return []

    for c in concepts:
        if colour[c.id] != WHITE:
            continue
        cycle = walk(c.id)
        if cycle:
            return cycle
    return []


def _reconstruct_cycle(
    parent: dict[str, str | None], cycle_tail: str, cycle_head: str
) -> list[str]:
    """Walk from ``cycle_tail`` back to ``cycle_head`` along parent pointers
    and return the cycle as ``[head, ..., tail, head]`` — first and last
    nodes are the same to make "this is a cycle" visually obvious."""
    path = [cycle_tail]
    cursor: str | None = cycle_tail
    while cursor is not None and cursor != cycle_head:
        cursor = parent.get(cursor)
        if cursor is None:
            break
        path.append(cursor)
    path.reverse()
    path.append(cycle_head)
    return path


# ─────────────────────────────────────────────────────────────────────────────
# Topological sort (deterministic)
# ─────────────────────────────────────────────────────────────────────────────


def topological_order(
    concepts: list[Concept], edges: list[ConceptEdge]
) -> list[str]:
    """Return concept ids in dependency-first order.

    Tied nodes (same in-degree) are emitted alphabetically by id so that two
    regenerations over the same course produce byte-identical roadmaps. Raises
    ``CycleFoundError`` if the graph is not a DAG.
    """
    cycle = validate_dag(concepts, edges)
    if cycle:
        raise CycleFoundError(cycle)

    adjacency = _directed_adjacency(concepts, edges)
    in_degree: dict[str, int] = {c.id: 0 for c in concepts}
    for _src, targets in adjacency.items():
        for t in targets:
            in_degree[t] = in_degree.get(t, 0) + 1

    ready: list[str] = sorted([cid for cid, deg in in_degree.items() if deg == 0])
    output: list[str] = []

    # We use a simple sorted-insertion list rather than a heap because the ready
    # set is small (per-course graphs have hundreds of nodes max). Stability
    # matters more than constant factors here.
    while ready:
        node = ready.pop(0)
        output.append(node)
        for neighbour in adjacency[node]:
            in_degree[neighbour] -= 1
            if in_degree[neighbour] == 0:
                _sorted_insert(ready, neighbour)

    if len(output) != len(in_degree):
        # Shouldn't happen — validate_dag already passed — but defend against
        # malformed input where an edge references an unknown concept id.
        missing = sorted(set(in_degree) - set(output))
        raise ValueError(f"topo sort incomplete; missing: {missing}")
    return output


def _sorted_insert(lst: list[str], item: str) -> None:
    """O(n) insertion that keeps the list alphabetically sorted."""
    for idx, existing in enumerate(lst):
        if item < existing:
            lst.insert(idx, item)
            return
    lst.append(item)


# ─────────────────────────────────────────────────────────────────────────────
# Prerequisite walk
# ─────────────────────────────────────────────────────────────────────────────


def prerequisites_of(
    target_id: str, edges: list[ConceptEdge]
) -> list[str]:
    """Return all transitive prerequisites of ``target_id``, closest-first.

    Walks edges of kind ``prerequisite_of`` in reverse: an edge ``A -> B``
    where ``B == target_id`` means A is a direct prerequisite, so we follow
    backward. Deduplicated; the result list preserves discovery order so
    callers can render "study A before B before C".
    """
    reverse: dict[str, list[str]] = defaultdict(list)
    for edge in edges:
        if edge.kind is ConceptEdgeKind.prerequisite_of:
            reverse[edge.to_id].append(edge.from_id)

    seen: set[str] = set()
    order: list[str] = []
    queue: deque[str] = deque([target_id])
    while queue:
        current = queue.popleft()
        for parent in sorted(reverse[current]):  # deterministic per layer
            if parent in seen:
                continue
            seen.add(parent)
            order.append(parent)
            queue.append(parent)
    return order


# ─────────────────────────────────────────────────────────────────────────────
# Effective difficulty propagation
# ─────────────────────────────────────────────────────────────────────────────


def effective_difficulty(
    concepts: list[Concept], edges: list[ConceptEdge]
) -> dict[str, int]:
    """For each concept, ``effective = max(self.difficulty, max(prereq.effective))``.

    Walks the graph in topological order so each node is visited exactly once.
    Used by the Roadmap Planner to weight milestone effort.
    """
    by_id: dict[str, Concept] = {c.id: c for c in concepts}
    order = topological_order(concepts, edges)

    prereq_edges: dict[str, list[str]] = defaultdict(list)
    for edge in edges:
        if edge.kind is ConceptEdgeKind.prerequisite_of:
            prereq_edges[edge.to_id].append(edge.from_id)

    effective: dict[str, int] = {}
    for cid in order:
        own = by_id[cid].difficulty
        max_prereq = max(
            (effective.get(p, 0) for p in prereq_edges.get(cid, [])),
            default=0,
        )
        effective[cid] = max(own, max_prereq)
    return effective


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────


def _directed_adjacency(
    concepts: list[Concept], edges: list[ConceptEdge]
) -> dict[str, list[str]]:
    """Adjacency of *directional* edge kinds only.

    ``prerequisite_of`` and ``derived_from`` are directional; ``related_to``,
    ``example_of``, and ``contradicts`` are treated as symmetric and excluded
    from acyclicity / topo-sort considerations.
    """
    adjacency: dict[str, list[str]] = {c.id: [] for c in concepts}
    for edge in edges:
        if edge.kind in {
            ConceptEdgeKind.prerequisite_of,
            ConceptEdgeKind.derived_from,
        }:
            adjacency.setdefault(edge.from_id, []).append(edge.to_id)
    for cid in adjacency:
        adjacency[cid].sort()  # deterministic traversal
    return adjacency
