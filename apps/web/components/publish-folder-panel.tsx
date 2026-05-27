'use client';

import { useCallback, useEffect, useState } from 'react';
import { track } from '../lib/analytics';
import { relativeTime } from '../lib/format-document';
import {
  getShareForFolder,
  publishFolder,
  unpublishFolder,
  type SharedFolderRow,
} from '../lib/shared-folders-client';
import { useToast } from './toast';

interface Props {
  folderId: string;
  folderName: string;
}

/**
 * Compact panel inside FolderView that exposes the publish lifecycle:
 *
 *   • Not published → "Publish folder" button. One click → fresh share
 *     code. Re-publishing rotates the code.
 *   • Published → shows the share code with a copy-to-clipboard chip
 *     and an "Unpublish" link. Students paste the code on their
 *     dashboard to subscribe.
 *
 * We never expose the underlying share row id to the user — the share
 * code IS the identifier. Rotation discards prior codes.
 */
export function PublishFolderPanel({ folderId, folderName }: Props) {
  const toast = useToast();
  const [share, setShare] = useState<SharedFolderRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setShare(await getShareForFolder(folderId));
    } catch {
      // Non-fatal — the panel just won't show share state.
    } finally {
      setLoading(false);
    }
  }, [folderId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const publish = async () => {
    setBusy(true);
    setError(null);
    try {
      const row = await publishFolder(folderId);
      setShare(row);
      track('folder.published', { folderId });
      toast.success(`Folder published — share code ${row.code}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Publish failed');
    } finally {
      setBusy(false);
    }
  };

  const unpublish = async () => {
    if (!confirm(`Unpublish "${folderName}"? Subscribers will lose access.`)) return;
    setBusy(true);
    setError(null);
    try {
      await unpublishFolder(folderId);
      setShare(null);
      toast.success('Folder unpublished. Existing subscriptions stopped resolving.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unpublish failed');
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!share) return;
    try {
      await navigator.clipboard.writeText(share.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      toast.success(`Copied ${share.code}`);
    } catch {
      // ignore
    }
  };

  if (loading) return null;

  return (
    <section className="rounded-lg border border-border bg-muted/10 p-4">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">Share with a class</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {share
              ? 'This folder is published. Anyone with the share code can subscribe and use your materials in their own tutor / flashcards / scopes.'
              : 'Publish a code that lets other students (or your professor) subscribe to this folder read-only.'}
          </p>
        </div>
      </header>

      {share ? (
        <div className="mt-3 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <code className="rounded bg-foreground px-3 py-1.5 font-mono text-sm tracking-widest text-background">
              {share.code}
            </code>
            <button
              type="button"
              onClick={() => void copy()}
              className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent"
            >
              {copied ? '✓ Copied' : 'Copy code'}
            </button>
            <button
              type="button"
              onClick={() => void publish()}
              disabled={busy}
              className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-50"
            >
              Rotate code
            </button>
            <button
              type="button"
              onClick={() => void unpublish()}
              disabled={busy}
              className="rounded-md border border-rose-200 px-3 py-1.5 text-xs text-rose-700 hover:bg-rose-50 disabled:opacity-50"
            >
              Unpublish
            </button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Published {relativeTime(share.createdAt)}. Rotating
            invalidates the old code immediately.
          </p>
        </div>
      ) : (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => void publish()}
            disabled={busy}
            className="rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background hover:opacity-90 disabled:opacity-50"
          >
            {busy ? 'Publishing…' : 'Publish folder'}
          </button>
        </div>
      )}

      {error && (
        <p className="mt-3 rounded bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</p>
      )}
    </section>
  );
}
