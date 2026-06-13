'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { fetchChunk, type ChunkDetail } from '../lib/chunks-client';
import { loadChunks } from '../lib/local-models-db';
import { useAuth } from './auth-gate';

/**
 * Right-side slide-over that shows the actual source chunk behind a
 * citation. Two modes:
 *
 *   • cloud  — pulls from /v1/chunks/:id (with neighbors). Used by all
 *              server-RAG surfaces (cloud tutor, exam-scope, ask-sheet).
 *   • offline — pulls from IndexedDB. Used by the offline tutor so the
 *              flow works without a network.
 *
 * Renders metadata up top, the chunk body in the middle, neighbor previews
 * folded into <details> at the bottom (so the user can pull more context
 * without leaving the panel). Copy + dismiss actions in the header.
 */

export type CitationSource =
  | { kind: 'cloud'; chunkId: string; docId?: string; page?: number | null }
  | {
      kind: 'offline';
      folderId: string;
      chunkId: string;
      docId?: string;
      page?: number | null;
      filename?: string;
      content?: string;
    };

interface Props {
  source: CitationSource;
  onClose: () => void;
}

interface LocalView {
  chunkId: string;
  content: string;
  filename: string;
  page: number | null;
  neighbors: { prev: ChunkNeighborView | null; next: ChunkNeighborView | null };
}

interface ChunkNeighborView {
  chunkId: string;
  content: string;
  page: number | null;
}

export function CitationPreview({ source, onClose }: Props) {
  const tc = useTranslations('common');
  const { me } = useAuth();
  const [view, setView] = useState<LocalView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (source.kind === 'cloud') {
          const c = await fetchChunk(source.chunkId);
          if (cancelled) return;
          setView(cloudToView(c));
        } else if (source.kind === 'offline') {
          if (!me) throw new Error('not signed in');
          const all = await loadChunks(me.userId, source.folderId);
          if (cancelled) return;
          const idx = all.findIndex((c) => c.chunkId === source.chunkId);
          if (idx === -1) {
            // The offline-tutor pre-fetched these chunks; the citation
            // might point at one that was rebuilt out. Show the raw
            // content the citation already carried, if any.
            if (source.content) {
              setView({
                chunkId: source.chunkId,
                content: source.content,
                filename: source.filename ?? 'Source',
                page: source.page ?? null,
                neighbors: { prev: null, next: null },
              });
            } else {
              throw new Error('Source chunk not in local index. Rebuild the offline tutor to refresh.');
            }
          } else {
            const c = all[idx]!;
            const prev = idx > 0 ? all[idx - 1] : null;
            const next = idx < all.length - 1 ? all[idx + 1] : null;
            setView({
              chunkId: c.chunkId,
              content: c.content,
              filename: c.filename,
              page: c.page,
              neighbors: {
                prev: prev
                  ? { chunkId: prev.chunkId, content: prev.content, page: prev.page }
                  : null,
                next: next
                  ? { chunkId: next.chunkId, content: next.content, page: next.page }
                  : null,
              },
            });
          }
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [source, me]);

  const onCopy = async () => {
    if (!view) return;
    try {
      await navigator.clipboard.writeText(view.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      data-selection-ignore
      className="fixed inset-0 z-50 flex justify-end bg-black/40"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex h-full w-full max-w-xl flex-col overflow-hidden border-l border-border bg-background shadow-xl">
        <header className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold">
              {view?.filename ?? 'Source'}
            </h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {view
                ? `Chunk ${view.chunkId.slice(0, 8)}…${
                    view.page !== null ? ` · page ${view.page}` : ''
                  }`
                : tc('loading')}
            </p>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => void onCopy()}
              disabled={!view}
              className="rounded px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
            >
              {copied ? '✓ Copied' : 'Copy'}
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="rounded px-2 py-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              ✕
            </button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {error && (
            <p className="rounded bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</p>
          )}

          {view && (
            <>
              <article className="whitespace-pre-wrap text-sm leading-relaxed">
                {view.content}
              </article>

              {(view.neighbors.prev || view.neighbors.next) && (
                <div className="mt-6 space-y-3">
                  {view.neighbors.prev && (
                    <Neighbor label="Before" n={view.neighbors.prev} />
                  )}
                  {view.neighbors.next && (
                    <Neighbor label="After" n={view.neighbors.next} />
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Neighbor({ label, n }: { label: string; n: ChunkNeighborView }) {
  return (
    <details className="rounded-md border border-border bg-muted/20 p-3 text-xs">
      <summary className="cursor-pointer text-muted-foreground">
        {label} chunk{n.page !== null ? ` · page ${n.page}` : ''}
      </summary>
      <p className="mt-2 whitespace-pre-wrap leading-relaxed">{n.content}</p>
    </details>
  );
}

function cloudToView(c: ChunkDetail): LocalView {
  return {
    chunkId: c.chunkId,
    content: c.content,
    filename: c.documentFilename,
    page: c.page,
    neighbors: {
      prev: c.neighbors.prev
        ? {
            chunkId: c.neighbors.prev.chunkId,
            content: c.neighbors.prev.content,
            page: c.neighbors.prev.page,
          }
        : null,
      next: c.neighbors.next
        ? {
            chunkId: c.neighbors.next.chunkId,
            content: c.neighbors.next.content,
            page: c.neighbors.next.page,
          }
        : null,
    },
  };
}
