'use client';

import { useEffect, useRef, useState } from 'react';
import { apiGet, apiPost, ApiError } from '../lib/dev-fetch';

interface Notification {
  id: string;
  kind: string;
  subject: string;
  body: string;
  state: string;
  createdAt: string;
  readAt: string | null;
}

interface InboxResponse {
  notifications: Notification[];
  unreadCount: number;
}

const KIND_LABELS: Record<string, string> = {
  upload_ready: 'Material indexed',
  milestone_due: 'Milestone due',
  quiz_due: 'Quiz due',
  weekly_digest: 'Weekly digest',
  system: 'System',
};

/**
 * Header bell with an unread-count badge. Opens a popover containing the
 * inbox list. Mirrors the universal pattern from GitHub / Linear / Slack
 * — moves notifications off the dashboard's prime real estate while
 * still keeping them one click away from every page.
 */
export function NotificationsBell() {
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const refresh = async () => {
    try {
      const res = await apiGet<InboxResponse>('/v1/notifications');
      setItems(res.notifications);
      setUnread(res.unreadCount);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load');
    }
  };

  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const markRead = async (id: string) => {
    setBusyId(id);
    try {
      await apiPost(`/v1/notifications/${id}/read`, {});
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to mark read');
    } finally {
      setBusyId(null);
    }
  };

  const markAllRead = async () => {
    const unreadItems = items.filter((n) => !n.readAt);
    if (unreadItems.length === 0) return;
    await Promise.all(
      unreadItems.map((n) =>
        apiPost(`/v1/notifications/${n.id}/read`, {}).catch(() => undefined),
      ),
    );
    await refresh();
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        aria-label={
          unread > 0 ? `Notifications (${unread} unread)` : 'Notifications'
        }
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="relative flex h-8 w-8 items-center justify-center rounded-full hover:bg-accent"
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {unread > 0 && (
          <span
            aria-hidden
            className="absolute -right-0.5 -top-0.5 flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-foreground px-1 text-[10px] font-medium text-background"
          >
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-10 z-20 w-80 rounded-md border border-border bg-background shadow-md">
          <header className="flex items-center justify-between border-b border-border px-3 py-2">
            <span className="text-sm font-medium">Notifications</span>
            {unread > 0 && (
              <button
                type="button"
                onClick={() => void markAllRead()}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                Mark all read
              </button>
            )}
          </header>

          <div className="max-h-96 overflow-y-auto">
            {error && (
              <p className="px-3 py-2 text-xs text-destructive">{error}</p>
            )}

            {items.length === 0 ? (
              <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                You're all caught up.
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {items.map((n) => {
                  const isUnread = !n.readAt;
                  return (
                    <li
                      key={n.id}
                      className={`flex gap-2 px-3 py-2.5 ${
                        isUnread ? 'bg-accent/30' : ''
                      }`}
                    >
                      <span
                        aria-hidden
                        className={`mt-1.5 h-2 w-2 flex-shrink-0 rounded-full ${
                          isUnread ? 'bg-foreground' : 'bg-transparent'
                        }`}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="truncate text-xs text-muted-foreground">
                            {KIND_LABELS[n.kind] ?? n.kind}
                          </span>
                          <time className="flex-shrink-0 text-[10px] text-muted-foreground">
                            {relativeShort(n.createdAt)}
                          </time>
                        </div>
                        <p className="mt-0.5 truncate text-sm font-medium">
                          {n.subject}
                        </p>
                        <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                          {n.body}
                        </p>
                        {isUnread && (
                          <button
                            type="button"
                            onClick={() => void markRead(n.id)}
                            disabled={busyId === n.id}
                            className="mt-1 text-[11px] text-muted-foreground underline hover:text-foreground disabled:opacity-50"
                          >
                            {busyId === n.id ? 'Marking…' : 'Mark read'}
                          </button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function relativeShort(iso: string): string {
  const t = new Date(iso).getTime();
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return 'now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(iso).toLocaleDateString();
}
