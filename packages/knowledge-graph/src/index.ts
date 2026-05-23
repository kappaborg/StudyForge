/**
 * Knowledge graph — TS-side type mirror of `apps/ai-worker/src/graph` outputs.
 *
 * The graph algorithms live in Python (Curriculum Builder + Roadmap Planner +
 * RAG expander). The FE consumes a Cytoscape spec served from the API; these
 * types define its shape so React components stay type-safe end to end.
 */

export type ConceptEdgeKind =
  | 'prerequisite_of'
  | 'related_to'
  | 'example_of'
  | 'derived_from'
  | 'contradicts';

export interface CytoscapeNodeData {
  id: string;
  label: string;
  difficulty: number;
  kind: 'concept';
  blockRefs: number[];
}

export interface CytoscapeEdgeData {
  id: string;
  source: string;
  target: string;
  kind: ConceptEdgeKind;
  weight: number;
  /** Lower = surfaced earlier by the RAG expander. */
  kindPriority: number;
}

export interface CytoscapePosition {
  x: number;
  y: number;
}

export interface CytoscapeNodeElement {
  data: CytoscapeNodeData;
  position?: CytoscapePosition;
}

export interface CytoscapeEdgeElement {
  data: CytoscapeEdgeData;
}

export type CytoscapeElement = CytoscapeNodeElement | CytoscapeEdgeElement;

export interface CytoscapeSpec {
  elements: CytoscapeElement[];
  meta: {
    nodeCount: number;
    edgeCount: number;
    /** Server embeds positions for small graphs (≤ 200 nodes); FE lays out
     *  larger graphs client-side. */
    isLayoutEmbedded: boolean;
  };
}

/**
 * Type guard for use in render loops where elements arrive as a flat array.
 */
export function isEdgeElement(el: CytoscapeElement): el is CytoscapeEdgeElement {
  return 'source' in el.data;
}
