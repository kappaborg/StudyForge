'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Background,
  Controls,
  Edge,
  MarkerType,
  MiniMap,
  Node,
  ReactFlow,
  ReactFlowProvider,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { track } from '../lib/analytics';
import { apiGet, apiPost, ApiError } from '../lib/dev-fetch';

interface Concept {
  id: string;
  label: string;
  description: string | null;
  difficulty: number;
}

interface ConceptEdge {
  fromId: string;
  toId: string;
  kind: string;
  weight: number;
}

interface ConceptGraph {
  courseId: string;
  concepts: Concept[];
  edges: ConceptEdge[];
}

const EDGE_COLORS: Record<string, string> = {
  prerequisite_of: '#3b82f6',
  related_to: '#a3a3a3',
  example_of: '#22c55e',
  derived_from: '#f59e0b',
  contradicts: '#ef4444',
};

const EDGE_LABELS: Record<string, string> = {
  prerequisite_of: 'prereq',
  related_to: 'related',
  example_of: 'example',
  derived_from: 'derived',
  contradicts: 'contradicts',
};

/** Layered layout: depth = longest ``prerequisite_of`` chain from any root. */
function layoutConcepts(concepts: Concept[], edges: ConceptEdge[]) {
  const prereqEdges = edges.filter((e) => e.kind === 'prerequisite_of');
  const inDegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const c of concepts) {
    inDegree.set(c.id, 0);
    outgoing.set(c.id, []);
  }
  for (const e of prereqEdges) {
    if (!inDegree.has(e.fromId) || !inDegree.has(e.toId)) continue;
    inDegree.set(e.toId, (inDegree.get(e.toId) ?? 0) + 1);
    outgoing.get(e.fromId)!.push(e.toId);
  }

  // Kahn-style longest-path levelling — depth is the longest prereq chain.
  const depth = new Map<string, number>();
  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) {
      depth.set(id, 0);
      queue.push(id);
    }
  }
  while (queue.length) {
    const id = queue.shift()!;
    const d = depth.get(id) ?? 0;
    for (const next of outgoing.get(id) ?? []) {
      depth.set(next, Math.max(depth.get(next) ?? 0, d + 1));
      inDegree.set(next, (inDegree.get(next) ?? 0) - 1);
      if ((inDegree.get(next) ?? 0) === 0) queue.push(next);
    }
  }
  // Anything not reached (cycle / disconnected) lands on the last layer.
  const maxDepth = Math.max(0, ...Array.from(depth.values()));
  for (const c of concepts) {
    if (!depth.has(c.id)) depth.set(c.id, maxDepth + 1);
  }

  // Column = depth; row = position within that depth.
  const cols = new Map<number, string[]>();
  for (const c of concepts) {
    const d = depth.get(c.id) ?? 0;
    const arr = cols.get(d) ?? [];
    arr.push(c.id);
    cols.set(d, arr);
  }

  const positions = new Map<string, { x: number; y: number }>();
  const colWidth = 260;
  const rowHeight = 110;
  for (const [d, ids] of cols) {
    ids.forEach((id, i) => {
      positions.set(id, {
        x: d * colWidth,
        y: i * rowHeight - ((ids.length - 1) * rowHeight) / 2,
      });
    });
  }
  return positions;
}

function ConceptNodeView({ data }: { data: Concept }) {
  const tier =
    data.difficulty < 33 ? 'border-emerald-500/60'
      : data.difficulty < 66 ? 'border-amber-500/60'
        : 'border-rose-500/60';
  return (
    <div
      className={`min-w-[180px] max-w-[220px] rounded-lg border-2 bg-background p-3 shadow-sm ${tier}`}
    >
      <div className="text-sm font-semibold leading-tight">{data.label}</div>
      {data.description && (
        <div className="mt-1 text-[10px] leading-snug text-muted-foreground line-clamp-3">
          {data.description}
        </div>
      )}
      <div className="mt-2 text-[10px] uppercase tracking-wider text-muted-foreground">
        difficulty {data.difficulty}
      </div>
    </div>
  );
}

const nodeTypes = { concept: ConceptNodeView } as const;

function GraphInner({ courseId }: { courseId: string }) {
  const [graph, setGraph] = useState<ConceptGraph | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [maxConcepts, setMaxConcepts] = useState(12);

  const refresh = async () => {
    try {
      const res = await apiGet<ConceptGraph>(`/v1/courses/${courseId}/concepts`);
      setGraph(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load graph');
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseId]);

  const onExtract = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await apiPost<ConceptGraph>('/v1/concepts/extract', {
        courseId,
        maxConcepts,
      });
      setGraph(res);
      track('concepts.extracted', {
        courseId,
        conceptCount: res.concepts.length,
        edgeCount: res.edges.length,
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Extraction failed');
    } finally {
      setBusy(false);
    }
  };

  const { nodes, edges } = useMemo(() => {
    if (!graph) return { nodes: [] as Node[], edges: [] as Edge[] };
    const positions = layoutConcepts(graph.concepts, graph.edges);
    const nodes: Node[] = graph.concepts.map((c) => ({
      id: c.id,
      type: 'concept',
      data: c as unknown as Record<string, unknown>,
      position: positions.get(c.id) ?? { x: 0, y: 0 },
    }));
    const edges: Edge[] = graph.edges.map((e, i) => ({
      id: `e${i}`,
      source: e.fromId,
      target: e.toId,
      label: EDGE_LABELS[e.kind] ?? e.kind,
      animated: e.kind === 'prerequisite_of',
      style: { stroke: EDGE_COLORS[e.kind] ?? '#a3a3a3', strokeWidth: 1 + e.weight * 1.5 },
      labelStyle: { fontSize: 10, fill: '#737373' },
      markerEnd: { type: MarkerType.ArrowClosed, color: EDGE_COLORS[e.kind] ?? '#a3a3a3' },
    }));
    return { nodes, edges };
  }, [graph]);

  return (
    <div className="space-y-3">
      <section className="rounded-lg border border-border p-4 space-y-3">
        <div className="flex flex-col gap-2 md:flex-row md:items-end">
          <div className="flex-1">
            <h3 className="text-sm font-semibold">Concept graph</h3>
            <p className="text-xs text-muted-foreground">
              Extracts up to N concepts + prerequisite edges from your materials.
            </p>
          </div>
          <div className="w-24">
            <label className="text-xs text-muted-foreground">Max concepts</label>
            <input
              type="number"
              min={3}
              max={40}
              value={maxConcepts}
              onChange={(e) =>
                setMaxConcepts(Math.max(3, Math.min(40, Number(e.target.value) || 3)))
              }
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            />
          </div>
          <button
            onClick={() => void onExtract()}
            disabled={busy}
            className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background hover:opacity-90 disabled:opacity-50"
          >
            {busy ? 'Extracting…' : graph && graph.concepts.length > 0 ? 'Re-extract' : 'Extract'}
          </button>
        </div>
        {error && <p className="text-xs text-red-500">{error}</p>}
        {graph && (
          <p className="text-xs text-muted-foreground">
            {graph.concepts.length} concepts · {graph.edges.length} edges
          </p>
        )}
      </section>

      <div className="h-[600px] w-full rounded-lg border border-border bg-card">
        {nodes.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            No graph yet — click <span className="mx-1 font-semibold">Extract</span> to build one.
          </div>
        ) : (
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            fitView
            minZoom={0.2}
            maxZoom={2}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={24} />
            <Controls />
            <MiniMap pannable zoomable />
          </ReactFlow>
        )}
      </div>
    </div>
  );
}

export function KnowledgeGraph({ courseId }: { courseId: string }) {
  return (
    <ReactFlowProvider>
      <GraphInner courseId={courseId} />
    </ReactFlowProvider>
  );
}
