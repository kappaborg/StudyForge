'use client';

import { useEffect, useState } from 'react';
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

export function NotificationsInbox() {
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const res = await apiGet<InboxResponse>('/v1/notifications');
      setItems(res.notifications);
      setUnread(res.unreadCount);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load inbox');
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

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

  return (
    <section className="space-y-3">
      <header className="flex items-baseline justify-between">
        <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          Inbox{unread > 0 && (
            <span className="ml-2 rounded-full bg-foreground px-2 py-0.5 text-xs text-background">
              {unread}
            </span>
          )}
        </h2>
        <button
          onClick={() => void refresh()}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          Refresh
        </button>
      </header>

      {error && <p className="text-xs text-red-500">{error}</p>}

      {items.length === 0 ? (
        <p className="rounded-md border border-dashed border-border p-4 text-xs text-muted-foreground">
          No notifications yet. Upload a file to see it here.
        </p>
      ) : (
        <ul className="space-y-2">
          {items.map((n) => {
            const isUnread = !n.readAt;
            return (
              <li
                key={n.id}
                className={`rounded-md border p-3 ${
                  isUnread ? 'border-foreground/40 bg-card' : 'border-border bg-muted/20'
                }`}
              >
                <div className="flex items-baseline justify-between gap-3">
                  <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    {KIND_LABELS[n.kind] ?? n.kind}
                  </div>
                  <time className="text-[10px] text-muted-foreground">
                    {new Date(n.createdAt).toLocaleString()}
                  </time>
                </div>
                <div className="mt-1 text-sm font-medium">{n.subject}</div>
                <div className="mt-1 text-xs text-muted-foreground">{n.body}</div>
                {isUnread && (
                  <button
                    onClick={() => void markRead(n.id)}
                    disabled={busyId === n.id}
                    className="mt-2 text-xs text-muted-foreground underline hover:text-foreground disabled:opacity-50"
                  >
                    {busyId === n.id ? 'Marking…' : 'Mark as read'}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
