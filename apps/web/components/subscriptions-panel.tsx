'use client';

import { useCallback, useEffect, useState } from 'react';
import { track } from '../lib/analytics';
import { relativeTime } from '../lib/format-document';
import {
  listSubscriptions,
  subscribeByCode,
  unsubscribe,
  type SubscriptionRow,
} from '../lib/shared-folders-client';
import { useToast } from './toast';

/**
 * Dashboard card: lists the user's active subscriptions to published
 * folders + a paste-code input to add a new one. Subscribed folders are
 * read-only — the user can ask the tutor / generate flashcards / build
 * offline models against the materials but can't upload or delete.
 *
 * On a fresh signup this renders just the "Subscribe to a class" input.
 * After subscribing, the row appears immediately with the publisher's
 * email and document count for context.
 */
export function SubscriptionsPanel() {
  const toast = useToast();
  const [subs, setSubs] = useState<SubscriptionRow[] | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setSubs(await listSubscriptions());
    } catch {
      // Non-fatal
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!code.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const row = await subscribeByCode(code.trim());
      track('folder.subscribed', { sharedFolderId: row.sharedFolderId });
      toast.success(`Subscribed to "${row.title}" by ${row.publishedBy}`);
      setCode('');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Subscribe failed');
    } finally {
      setBusy(false);
    }
  };

  const drop = async (row: SubscriptionRow) => {
    if (!confirm(`Unsubscribe from "${row.title}"?`)) return;
    try {
      await unsubscribe(row.id);
      toast.info(`Unsubscribed from ${row.title}`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unsubscribe failed');
    }
  };

  return (
    <section className="space-y-3">
      <header>
        <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          Shared with you
        </h2>
        <p className="text-xs text-muted-foreground">
          Subscribe with a code from a professor or classmate. Their materials
          show up in your tutor / flashcards / scopes (read-only).
        </p>
      </header>

      <form onSubmit={submit} className="flex flex-wrap gap-2">
        <input
          type="text"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="Paste share code (e.g. K7HF92RB)"
          disabled={busy}
          className="flex-1 min-w-[12rem] rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-foreground/30 uppercase tracking-widest"
          maxLength={32}
        />
        <button
          type="submit"
          disabled={busy || !code.trim()}
          className="rounded-md bg-foreground px-3 py-2 text-sm font-medium text-background hover:opacity-90 disabled:opacity-50"
        >
          {busy ? 'Subscribing…' : 'Subscribe'}
        </button>
      </form>

      {error && (
        <p className="rounded bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</p>
      )}

      {subs && subs.length > 0 && (
        <ul className="grid gap-2 md:grid-cols-2">
          {subs.map((s) => (
            <li
              key={s.id}
              className="rounded-md border border-border p-3 text-sm"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate font-medium">{s.title}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Published by {s.publishedBy} · {s.documentCount} document
                    {s.documentCount === 1 ? '' : 's'}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void drop(s)}
                  aria-label={`Unsubscribe from ${s.title}`}
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  ✕
                </button>
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Subscribed {relativeTime(s.subscribedAt)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
