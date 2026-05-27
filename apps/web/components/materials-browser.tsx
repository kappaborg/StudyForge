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
  kind: 'inbox' | 'materials' | 'trash';
}

type SortKey = 'recent' | 'name';

/**
 * Full materials surface with client-side search, folder filter, and sort.
 *
 * Used on ``/upload`` as the destination of the dashboard's "View all" link.
 * Caps the fetch at 100 (server's hard limit) so search/sort remain trivial;
 * if a tenant ever holds more than that, we'd switch to server-side paging.
 */
export function MaterialsBrowser({ pageLimit = 100 }: { pageLimit?: number }) {
  const [docs, setDocs] = React.useState<DocumentRow[] | null>(null);
  const [folders, setFolders] = React.useState<FolderRow[]>([]);
  const [folderMap, setFolderMap] = React.useState<Map<string, FolderRow>>(
    () => new Map(),
  );
  const [error, setError] = React.useState<string | null>(null);

  const [query, setQuery] = React.useState('');
  const [folderFilter, setFolderFilter] = React.useState<string>('all');
  const [sortKey, setSortKey] = React.useState<SortKey>('recent');

  React.useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [docRows, folderRows] = await Promise.all([
          apiGet<DocumentRow[]>(`/v1/documents?limit=${pageLimit}`),
          apiGet<FolderRow[]>('/v1/folders').catch(() => [] as FolderRow[]),
        ]);
        if (cancelled) return;
        setDocs(docRows);
        setFolders(folderRows);
        setFolderMap(new Map(folderRows.map((f) => [f.id, f])));
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
  }, [pageLimit]);

  const filtered = React.useMemo(() => {
    if (docs === null) return [];
    const q = query.trim().toLowerCase();
    let out = docs;
    if (folderFilter !== 'all') {
      out = out.filter((d) => d.folderId === folderFilter);
    }
    if (q.length > 0) {
      out = out.filter((d) => d.originalFilename.toLowerCase().includes(q));
    }
    if (sortKey === 'name') {
      out = [...out].sort((a, b) =>
        a.originalFilename.localeCompare(b.originalFilename),
      );
    } else {
      out = [...out].sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );
    }
    return out;
  }, [docs, query, folderFilter, sortKey]);

  const total = docs?.length ?? 0;
  const now = new Date();

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search materials by filename…"
          aria-label="Search materials"
          className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        />
        <select
          value={folderFilter}
          onChange={(e) => setFolderFilter(e.target.value)}
          aria-label="Filter by folder"
          className="rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="all">All folders</option>
          {folders.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
        <select
          value={sortKey}
          onChange={(e) => setSortKey(e.target.value as SortKey)}
          aria-label="Sort materials"
          className="rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="recent">Most recent</option>
          <option value="name">Name A–Z</option>
        </select>
      </div>

      {error !== null ? (
        <div className="rounded-md border border-destructive bg-destructive/10 p-3 text-sm text-destructive">
          Could not load materials: {error}
        </div>
      ) : docs === null ? (
        <SkeletonDocList rows={6} />
      ) : total === 0 ? (
        <div className="rounded-md border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          No materials yet. Drop a file in the upload zone to get started.
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-md border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          No matches for the current filter.
        </div>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            Showing {filtered.length} of {total} material
            {total === 1 ? '' : 's'}
          </p>
          <ul className="divide-y divide-border rounded-md border border-border">
            {filtered.map((d) => {
              const ext = friendlyExt(d.originalFilename, d.mime);
              const folder = d.folderId ? folderMap.get(d.folderId) : null;
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
                    <p className="truncate text-sm font-medium">
                      {d.originalFilename}
                    </p>
                    <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                      {folder && (
                        <span className="inline-flex items-center gap-1">
                          <span
                            aria-hidden
                            className="h-2 w-2 rounded-full"
                            style={{
                              backgroundColor: folder.color ?? '#94a3b8',
                            }}
                          />
                          <span className="truncate">{folder.name}</span>
                        </span>
                      )}
                      {folder && d.pageCount !== null && (
                        <span aria-hidden>·</span>
                      )}
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
        </>
      )}
    </div>
  );
}
