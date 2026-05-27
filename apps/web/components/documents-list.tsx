'use client';

import Link from 'next/link';
import * as React from 'react';
import { apiGet, ApiError } from '../lib/dev-fetch';
import { friendlyExt, relativeTime } from '../lib/format-document';
import { SkeletonDocList } from './skeleton';

interface DocumentRow {
  id: string;
  originalFilename: string;
  mime: string;
  pageCount: number | null;
  folderId: string | null;
  createdAt: string;
}

interface FolderRow {
  id: string;
  name: string;
  color: string | null;
}

export function DocumentsList({
  limit = 20,
  emptyHint = 'No materials yet — drop a file on the Materials page to get started.',
}: {
  limit?: number;
  emptyHint?: string;
}) {
  const [docs, setDocs] = React.useState<DocumentRow[] | null>(null);
  const [folders, setFolders] = React.useState<Map<string, FolderRow>>(
    () => new Map(),
  );
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [docRows, folderRows] = await Promise.all([
          apiGet<DocumentRow[]>(`/v1/documents?limit=${limit}`),
          apiGet<FolderRow[]>('/v1/folders').catch(() => [] as FolderRow[]),
        ]);
        if (cancelled) return;
        setDocs(docRows);
        setFolders(new Map(folderRows.map((f) => [f.id, f])));
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
    };
    void load();
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', onFocus);
    };
  }, [limit]);

  if (error !== null) {
    return (
      <div className="rounded-md border border-destructive bg-destructive/10 p-3 text-sm text-destructive">
        Could not load documents: {error}
      </div>
    );
  }

  if (docs === null) {
    return <SkeletonDocList rows={Math.min(limit, 6)} />;
  }

  if (docs.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
        {emptyHint}
      </div>
    );
  }

  const now = new Date();

  return (
    <ul className="divide-y divide-border rounded-md border border-border">
      {docs.map((d) => {
        const ext = friendlyExt(d.originalFilename, d.mime);
        const folder = d.folderId ? folders.get(d.folderId) : null;
        const href = d.folderId ? `/folders/${d.folderId}` : null;
        const row = (
          <div className="flex items-center gap-3 px-4 py-3">
            <span
              aria-hidden
              className="flex h-8 w-10 flex-shrink-0 items-center justify-center rounded bg-muted text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
            >
              {ext}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{d.originalFilename}</p>
              <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                {folder && (
                  <span className="inline-flex items-center gap-1">
                    <span
                      aria-hidden
                      className="h-2 w-2 rounded-full"
                      style={{ backgroundColor: folder.color ?? '#94a3b8' }}
                    />
                    <span className="truncate">{folder.name}</span>
                  </span>
                )}
                {folder && d.pageCount !== null && <span aria-hidden>·</span>}
                {d.pageCount !== null && (
                  <span>
                    {d.pageCount} page{d.pageCount === 1 ? '' : 's'}
                  </span>
                )}
              </div>
            </div>
            <span className="flex-shrink-0 text-xs text-muted-foreground">
              {relativeTime(d.createdAt, now)}
            </span>
          </div>
        );
        return (
          <li key={d.id}>
            {href ? (
              <Link href={href} className="block hover:bg-accent">
                {row}
              </Link>
            ) : (
              row
            )}
          </li>
        );
      })}
    </ul>
  );
}
