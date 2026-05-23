'use client';

import * as React from 'react';
import { apiGet, ApiError } from '../lib/dev-fetch';

interface DocumentRow {
  id: string;
  originalFilename: string;
  mime: string;
  pageCount: number | null;
  chunkCount: number;
  createdAt: string;
}

export function DocumentsList({
  limit = 20,
  emptyHint = 'No materials yet — drop a PDF on the Upload page to get started.',
}: {
  limit?: number;
  emptyHint?: string;
}) {
  const [docs, setDocs] = React.useState<DocumentRow[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [reloadTick, setReloadTick] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rows = await apiGet<DocumentRow[]>(`/v1/documents?limit=${limit}`);
        if (!cancelled) setDocs(rows);
      } catch (err) {
        if (cancelled) return;
        setError(
          err instanceof ApiError
            ? (err.problem.detail ?? err.problem.title ?? 'load failed')
            : err instanceof Error
              ? err.message
              : 'load failed',
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [limit, reloadTick]);

  if (error !== null) {
    return (
      <div className="rounded-md border border-destructive bg-destructive/10 p-3 text-sm text-destructive">
        Could not load documents: {error}
      </div>
    );
  }

  if (docs === null) {
    return (
      <div className="rounded-md border border-border p-6 text-center text-sm text-muted-foreground">
        Loading documents…
      </div>
    );
  }

  if (docs.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
        {emptyHint}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs uppercase tracking-wider text-muted-foreground">
          {docs.length} document{docs.length === 1 ? '' : 's'}
        </p>
        <button
          type="button"
          onClick={() => setReloadTick((t) => t + 1)}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          Refresh
        </button>
      </div>
      <ul className="divide-y divide-border rounded-md border border-border">
        {docs.map((d) => (
          <li key={d.id} className="flex items-center justify-between gap-4 px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{d.originalFilename}</p>
              <p className="text-xs text-muted-foreground">
                {d.pageCount ?? '?'} page{d.pageCount === 1 ? '' : 's'} · {d.chunkCount} chunk{d.chunkCount === 1 ? '' : 's'} · uploaded{' '}
                {new Date(d.createdAt).toLocaleString()}
              </p>
            </div>
            <span className="rounded bg-muted px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
              {d.id.slice(0, 8)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
