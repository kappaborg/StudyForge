'use client';

import { useEffect, useState } from 'react';
import {
  createScopeShareLink,
  getScopeShareLink,
  revokeScopeShareLink,
  type ScopeShareLink,
} from '../lib/exam-scopes-client';
import { relativeTime } from '../lib/format-document';
import { useToast } from './toast';

interface Props {
  scopeId: string;
  scopeTitle: string;
  onClose: () => void;
}

/**
 * Share-link manager modal. Owner-only — opens from the Share button on
 * ExamScopeView.
 *
 *   - Not shared yet → "Create share link" button → mints + displays full URL
 *   - Already shared → URL + Copy + Rotate (mint fresh, invalidate old) + Revoke
 *
 * Forks happen on the acceptor side. Each fork creates an independent
 * ExamScope row in the acceptor's tenant attached to a folder they own,
 * so the publisher's scope can be re-edited or revoked without affecting
 * forks already made.
 */
export function ShareScopeModal({ scopeId, scopeTitle, onClose }: Props) {
  const toast = useToast();
  const [link, setLink] = useState<ScopeShareLink | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        setLink(await getScopeShareLink(scopeId));
      } catch {
        // ignore — modal still functions
      } finally {
        setLoading(false);
      }
    })();
  }, [scopeId]);

  const create = async (rotate: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const next = await createScopeShareLink(scopeId, { rotate });
      setLink(next);
      if (rotate) toast.success('Share link rotated — old URL invalidated');
      else toast.success('Share link created');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create link');
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    if (!confirm('Revoke the share link? Existing forks keep working; new accepts will fail.')) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await revokeScopeShareLink(scopeId);
      setLink(null);
      toast.info('Share link revoked');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Revoke failed');
    } finally {
      setBusy(false);
    }
  };

  const fullUrl = link
    ? `${typeof window !== 'undefined' ? window.location.origin : ''}/shared/scopes/${link.token}`
    : '';

  const copy = async () => {
    if (!fullUrl) return;
    try {
      await navigator.clipboard.writeText(fullUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      toast.success('Share link copied');
    } catch {
      // ignore
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      data-selection-ignore
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-24"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-lg rounded-lg border border-border bg-background p-5 shadow-xl">
        <header className="mb-3 flex items-start justify-between">
          <div>
            <h3 className="text-base font-semibold">Share exam scope</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Send the link to classmates studying for "{scopeTitle}". They get a
              fork they can attach to their own folder.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-muted-foreground hover:text-foreground"
          >
            ✕
          </button>
        </header>

        {loading ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : link ? (
          <div className="space-y-3">
            <label className="block text-xs">
              <span className="text-muted-foreground">Share link</span>
              <input
                readOnly
                value={fullUrl}
                onClick={(e) => (e.target as HTMLInputElement).select()}
                className="mt-1 block w-full rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-xs"
              />
            </label>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void copy()}
                className="rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background hover:opacity-90"
              >
                {copied ? '✓ Copied' : 'Copy link'}
              </button>
              <button
                type="button"
                onClick={() => void create(true)}
                disabled={busy}
                className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-50"
              >
                Rotate
              </button>
              <button
                type="button"
                onClick={() => void revoke()}
                disabled={busy}
                className="rounded-md border border-rose-200 px-3 py-1.5 text-xs text-rose-700 hover:bg-rose-50 disabled:opacity-50"
              >
                Revoke
              </button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Created {relativeTime(link.createdAt)}. Rotating
              invalidates the old URL immediately.
            </p>
          </div>
        ) : (
          <div>
            <button
              type="button"
              onClick={() => void create(false)}
              disabled={busy}
              className="rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background hover:opacity-90 disabled:opacity-50"
            >
              {busy ? 'Creating…' : 'Create share link'}
            </button>
          </div>
        )}

        {error && (
          <p className="mt-3 rounded bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</p>
        )}
      </div>
    </div>
  );
}
