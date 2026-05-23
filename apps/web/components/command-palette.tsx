'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { track } from '../lib/analytics';
import { apiGet, ApiError } from '../lib/dev-fetch';

interface SearchHit {
  kind: 'document' | 'chunk' | 'concept';
  id: string;
  title: string;
  snippet: string;
  docId?: string;
  courseId?: string | null;
  page?: number | null;
}

const KIND_LABEL: Record<SearchHit['kind'], string> = {
  document: 'Document',
  chunk: 'Passage',
  concept: 'Concept',
};

function hrefFor(hit: SearchHit): string {
  if (hit.kind === 'concept' && hit.courseId) {
    return `/courses/${hit.courseId}/graph`;
  }
  if (hit.kind === 'chunk' && hit.courseId) {
    return `/courses/${hit.courseId}`;
  }
  if (hit.kind === 'document') {
    return '/dashboard';
  }
  return '/dashboard';
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Global hotkey: cmd/ctrl + k toggles the palette.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === 'Escape' && open) {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => {
    if (open) {
      const id = window.setTimeout(() => inputRef.current?.focus(), 30);
      return () => window.clearTimeout(id);
    }
    // reset on close
    setQ('');
    setHits([]);
    setError(null);
    setActiveIdx(0);
    return undefined;
  }, [open]);

  // Debounced search.
  useEffect(() => {
    if (!open) return;
    const query = q.trim();
    if (query.length === 0) {
      setHits([]);
      return;
    }
    const handle = window.setTimeout(async () => {
      setBusy(true);
      setError(null);
      try {
        const res = await apiGet<{ hits: SearchHit[] }>(
          `/v1/search?q=${encodeURIComponent(query)}&limit=8`,
        );
        setHits(res.hits);
        setActiveIdx(0);
        track('search.queried', { query, hits: res.hits.length });
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Search failed');
      } finally {
        setBusy(false);
      }
    }, 180);
    return () => window.clearTimeout(handle);
  }, [q, open]);

  const onArrow = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIdx((i) => Math.min(i + 1, Math.max(0, hits.length - 1)));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIdx((i) => Math.max(0, i - 1));
      } else if (e.key === 'Enter' && hits[activeIdx]) {
        const href = hrefFor(hits[activeIdx]!);
        window.location.href = href;
      }
    },
    [hits, activeIdx],
  );

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-24"
      onClick={() => setOpen(false)}
      role="presentation"
    >
      <div
        className="w-full max-w-xl rounded-lg border border-border bg-background shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Search palette"
      >
        <input
          ref={inputRef}
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onArrow}
          placeholder="Search documents, passages, concepts…"
          aria-label="Search query"
          className="w-full rounded-t-lg border-b border-border bg-transparent px-4 py-3 text-sm outline-none"
        />
        <div className="max-h-96 overflow-auto">
          {busy && q.trim() && (
            <p className="px-4 py-3 text-xs text-muted-foreground">Searching…</p>
          )}
          {!busy && q.trim() && hits.length === 0 && !error && (
            <p className="px-4 py-3 text-xs text-muted-foreground">No matches.</p>
          )}
          {error && <p className="px-4 py-3 text-xs text-red-500">{error}</p>}
          <ul>
            {hits.map((hit, i) => (
              <li key={`${hit.kind}-${hit.id}`}>
                <Link
                  href={hrefFor(hit)}
                  onClick={() => setOpen(false)}
                  className={`block border-l-2 px-4 py-2.5 text-sm hover:bg-accent ${
                    i === activeIdx ? 'border-foreground bg-accent' : 'border-transparent'
                  }`}
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="font-medium">{hit.title}</span>
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      {KIND_LABEL[hit.kind]}
                      {hit.page ? ` · p${hit.page}` : ''}
                    </span>
                  </div>
                  {hit.snippet && (
                    <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                      {hit.snippet}
                    </p>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        </div>
        <div className="flex items-center justify-between border-t border-border px-4 py-2 text-[10px] uppercase tracking-wider text-muted-foreground">
          <span>↑↓ navigate · ⏎ open · esc close</span>
          <span>⌘K to toggle</span>
        </div>
      </div>
    </div>
  );
}
