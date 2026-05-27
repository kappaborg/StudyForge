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
  folderId: string | null;
  createdAt: string;
}

export function RecentUploads({ limit = 5 }: { limit?: number }) {
  const [docs, setDocs] = React.useState<DocumentRow[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    const load = async () => {
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
      <p className="text-xs text-destructive">
        Could not load recent uploads: {error}
      </p>
    );
  }

  if (docs === null) {
    return <SkeletonDocList rows={limit} />;
  }

  if (docs.length === 0) {
    return null;
  }

  const now = new Date();

  return (
    <ul className="divide-y divide-border rounded-md border border-border">
      {docs.map((d) => {
        const ext = friendlyExt(d.originalFilename, d.mime);
        const href = d.folderId ? `/folders/${d.folderId}` : '/upload';
        return (
          <li key={d.id}>
            <Link
              href={href}
              className="flex items-center gap-3 px-4 py-3 hover:bg-accent"
            >
              <span
                aria-hidden
                className="flex h-8 w-10 flex-shrink-0 items-center justify-center rounded bg-muted text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
              >
                {ext}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                {d.originalFilename}
              </span>
              <span className="flex-shrink-0 text-xs text-muted-foreground">
                {relativeTime(d.createdAt, now)}
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
