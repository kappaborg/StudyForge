'use client';

import { useEffect, useRef, useState } from 'react';
import mermaid from 'mermaid';
import { track } from '../lib/analytics';
import { apiPost, ApiError } from '../lib/dev-fetch';

type Kind = 'flowchart' | 'mindmap' | 'sequence';

interface DiagramDto {
  courseId: string;
  kind: string;
  renderer: string;
  source: string;
}

mermaid.initialize({
  startOnLoad: false,
  theme: 'default',
  securityLevel: 'strict',
  fontFamily: 'inherit',
});

/**
 * Download the currently-rendered Mermaid SVG to disk. Mermaid emits an
 * ``<svg>`` element under our ``renderRef`` host once render() completes;
 * we copy its outerHTML and stamp the XML namespace so the file opens in
 * any image viewer (Mermaid omits the namespace by default).
 */
function downloadDiagram(host: HTMLDivElement | null, kind: string): void {
  if (typeof window === 'undefined' || !host) return;
  const svg = host.querySelector('svg');
  if (!svg) return;
  // The XML namespace is required for browsers + image viewers to
  // recognise the file as standalone SVG.
  const clone = svg.cloneNode(true) as SVGElement;
  if (!clone.getAttribute('xmlns')) {
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  }
  const blob = new Blob([clone.outerHTML], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `studyforge-${kind}-${new Date().toISOString().slice(0, 10)}.svg`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function DiagramsPanel({ courseId }: { courseId: string }) {
  const [kind, setKind] = useState<Kind>('flowchart');
  const [query, setQuery] = useState('');
  const [diagram, setDiagram] = useState<DiagramDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);
  const renderRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!diagram || !renderRef.current) return;
    const target = renderRef.current;
    const id = `mmd-${Math.random().toString(36).slice(2)}`;
    let cancelled = false;
    (async () => {
      try {
        const { svg } = await mermaid.render(id, diagram.source);
        if (!cancelled) target.innerHTML = svg;
      } catch (err) {
        if (!cancelled) {
          target.innerHTML = '';
          setError(
            err instanceof Error
              ? `Mermaid failed to render: ${err.message.slice(0, 240)}`
              : 'Mermaid render failed',
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [diagram]);

  const onGenerate = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await apiPost<DiagramDto>('/v1/diagrams/generate', {
        courseId,
        query: query.trim() || undefined,
        kind,
      });
      setDiagram(res);
      track('diagram.generated', { courseId, kind });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Generation failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <section className="rounded-lg border border-border p-4 space-y-3">
        <h3 className="text-sm font-semibold">Generate a diagram</h3>
        <div className="flex flex-col gap-2 md:flex-row md:items-end">
          <div className="flex-1">
            <label className="text-xs text-muted-foreground">Topic (optional)</label>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="leave empty for the dominant relationships"
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            />
          </div>
          <div className="w-40">
            <label className="text-xs text-muted-foreground">Kind</label>
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as Kind)}
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            >
              <option value="flowchart">Flowchart</option>
              <option value="mindmap">Mindmap</option>
              <option value="sequence">Sequence</option>
            </select>
          </div>
          <button
            onClick={() => void onGenerate()}
            disabled={busy}
            className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background hover:opacity-90 disabled:opacity-50"
          >
            {busy ? 'Drawing…' : 'Generate'}
          </button>
        </div>
        {error && <p className="text-xs text-red-500">{error}</p>}
      </section>

      {diagram && (
        <section className="space-y-3">
          <header className="flex items-baseline justify-between gap-3">
            <h3 className="text-sm font-semibold">{diagram.kind}</h3>
            <div className="flex items-center gap-3">
              <button
                onClick={() => downloadDiagram(renderRef.current, diagram.kind)}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                Download SVG
              </button>
              <button
                onClick={() => setShowSource((s) => !s)}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                {showSource ? 'Hide source' : 'View source'}
              </button>
            </div>
          </header>
          <div
            ref={renderRef}
            className="overflow-auto rounded-lg border border-border bg-card p-6"
          />
          {showSource && (
            <pre className="overflow-auto rounded-md border border-border bg-muted/30 p-3 text-xs">
              <code>{diagram.source}</code>
            </pre>
          )}
        </section>
      )}
    </div>
  );
}
