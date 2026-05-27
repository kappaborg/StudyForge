'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { track } from '../lib/analytics';
import {
  acceptSharedScope,
  previewSharedScope,
  type ScopePreview,
} from '../lib/exam-scopes-client';
import { useFolders } from '../lib/folders';
import { relativeDayLabel } from '../lib/format-document';
import { Skeleton } from './skeleton';

interface Props {
  token: string;
}

/**
 * Acceptor-side workspace. Shows the shared scope's structure (chapters
 * + topics + mode + exam date + the originator's folder name + their
 * email) and lets the user fork it into one of THEIR folders.
 *
 * Why pick a folder explicitly? Forks need to attach to materials the
 * acceptor can actually retrieve. The original publisher's folder isn't
 * automatically accessible — that's a separate publish/subscribe path
 * (instructor-shared folders). Keeping the two flows independent means
 * each works without the other.
 */
export function AcceptScopeView({ token }: Props) {
  const router = useRouter();
  const { folders } = useFolders();
  const [preview, setPreview] = useState<ScopePreview | null>(null);
  const [folderId, setFolderId] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ownableFolders = folders.filter((f) => f.kind === 'materials');

  useEffect(() => {
    (async () => {
      try {
        setPreview(await previewSharedScope(token));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not load share');
      }
    })();
  }, [token]);

  useEffect(() => {
    // Default to first owned folder so the button is enabled out of the box.
    if (!folderId && ownableFolders.length > 0 && ownableFolders[0]) {
      setFolderId(ownableFolders[0].id);
    }
  }, [folderId, ownableFolders]);

  const accept = useCallback(async () => {
    if (!folderId || busy) return;
    setBusy(true);
    setError(null);
    try {
      const row = await acceptSharedScope(token, folderId);
      track('scope.forked', { scopeId: row.id });
      router.replace(`/exam-scopes/${row.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Accept failed');
      setBusy(false);
    }
  }, [busy, folderId, router, token]);

  if (error && !preview) {
    return (
      <main className="mx-auto max-w-xl py-16 text-center">
        <h1 className="text-xl font-semibold">Share unavailable</h1>
        <p className="mt-2 text-sm text-muted-foreground">{error}</p>
      </main>
    );
  }

  if (!preview) {
    return (
      <main
        role="status"
        aria-busy="true"
        aria-label="Loading shared scope"
        className="mx-auto max-w-xl space-y-6 py-12"
      >
        <header className="space-y-2">
          <Skeleton className="h-2 w-32" />
          <Skeleton className="h-7 w-2/3" />
          <Skeleton className="h-3 w-1/2" />
        </header>
        <Skeleton className="h-40 w-full rounded-lg" />
        <Skeleton className="h-10 w-32" />
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-xl space-y-6 py-12">
      <header>
        <p className="text-xs uppercase tracking-widest text-muted-foreground">
          Shared exam scope
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">{preview.title}</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          Shared by {preview.sharedBy} · originally tied to folder "{preview.sourceFolderName}"
          {preview.examDate && ` · exam ${relativeDayLabel(preview.examDate)}`}
        </p>
      </header>

      <section className="rounded-lg border border-border bg-muted/10 p-4">
        <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          You'll get a fork of these scopes
        </h2>
        <ul className="mt-2 space-y-2">
          {preview.scopes.map((s, i) => (
            <li key={i} className="rounded-md border border-border bg-background p-3">
              <div className="flex flex-wrap items-baseline gap-2">
                <span
                  className={`rounded px-2 py-0.5 text-[10px] uppercase tracking-wider ${
                    s.mode === 'problems'
                      ? 'bg-amber-100 text-amber-800'
                      : 'bg-sky-100 text-sky-800'
                  }`}
                >
                  {s.mode}
                </span>
                <span className="text-xs text-muted-foreground">
                  Chapters {s.chapters.join(', ') || '—'}
                </span>
              </div>
              {s.topics.length > 0 && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Topics: {s.topics.join(', ')}
                </p>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-2">
        <label className="block text-sm">
          <span className="text-muted-foreground">Attach to which folder of yours?</span>
          <select
            value={folderId}
            onChange={(e) => setFolderId(e.target.value)}
            disabled={busy || ownableFolders.length === 0}
            className="mt-1 block w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          >
            {ownableFolders.length === 0 && (
              <option value="">No folders yet — create one first</option>
            )}
            {ownableFolders.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </label>
        <p className="text-[11px] text-muted-foreground">
          Forks live in your tenant. You can edit the chapter list, change the
          exam date, or re-share without affecting the original.
        </p>
      </section>

      {error && (
        <p className="rounded bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</p>
      )}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={() => router.replace('/dashboard')}
          disabled={busy}
          className="rounded-md border border-border px-4 py-2 text-sm hover:bg-accent disabled:opacity-50"
        >
          Not now
        </button>
        <button
          type="button"
          onClick={() => void accept()}
          disabled={busy || !folderId}
          className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background hover:opacity-90 disabled:opacity-50"
        >
          {busy ? 'Forking…' : 'Add to my folder'}
        </button>
      </div>
    </main>
  );
}
