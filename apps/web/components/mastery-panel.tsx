'use client';

import { useEffect, useState } from 'react';
import { apiGet, ApiError } from '../lib/dev-fetch';

interface MasteryRow {
  conceptId: string;
  label: string;
  mastery: number;
  attempts: number;
  correct: number;
  lastSeenAt: string;
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

function masteryTier(m: number): { label: string; color: string } {
  if (m >= 0.8) return { label: 'mastered', color: 'bg-emerald-500' };
  if (m >= 0.5) return { label: 'progressing', color: 'bg-amber-500' };
  if (m > 0) return { label: 'learning', color: 'bg-rose-500' };
  return { label: 'untouched', color: 'bg-muted-foreground/40' };
}

export function MasteryPanel({ courseId }: { courseId: string }) {
  const [rows, setRows] = useState<MasteryRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiGet<{ mastery: MasteryRow[] }>(`/v1/courses/${courseId}/mastery`);
      setRows(res.mastery);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load mastery');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseId]);

  const sorted = [...rows].sort((a, b) => b.mastery - a.mastery);
  const touched = rows.filter((r) => r.attempts > 0);
  const avg =
    touched.length === 0 ? 0 : touched.reduce((acc, r) => acc + r.mastery, 0) / touched.length;

  return (
    <section className="space-y-4">
      <header className="flex items-baseline justify-between">
        <div>
          <h2 className="text-sm font-semibold">Concept mastery</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Updated by quiz submissions. BKT-lite per concept (learn rate 0.4 · slip 0.7).
          </p>
        </div>
        <button
          onClick={() => void refresh()}
          className="rounded-md border border-border px-3 py-1 text-xs hover:bg-accent"
        >
          Refresh
        </button>
      </header>

      {touched.length > 0 && (
        <div className="rounded-md border border-border bg-card p-3 text-sm">
          <div className="text-xs uppercase tracking-wider text-muted-foreground">
            Average across touched concepts
          </div>
          <div className="mt-1 text-2xl font-semibold">{pct(avg)}</div>
          <div className="mt-1 text-xs text-muted-foreground">
            {touched.length} of {rows.length} concept{rows.length === 1 ? '' : 's'} attempted
          </div>
        </div>
      )}

      {error && <p className="text-xs text-red-500">{error}</p>}
      {loading && rows.length === 0 && (
        <p className="text-xs text-muted-foreground">Loading mastery…</p>
      )}
      {!loading && rows.length === 0 && (
        <p className="rounded-md border border-dashed border-border p-4 text-xs text-muted-foreground">
          No concepts yet. Build the concept graph from the Graph tab first, then take a quiz.
        </p>
      )}

      <ul className="space-y-2">
        {sorted.map((row) => {
          const tier = masteryTier(row.mastery);
          const width = Math.max(2, Math.round(row.mastery * 100));
          return (
            <li
              key={row.conceptId}
              className="rounded-md border border-border bg-card p-3"
            >
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-sm font-medium">{row.label}</span>
                <span className="text-xs text-muted-foreground whitespace-nowrap">
                  {pct(row.mastery)} · {row.correct}/{row.attempts} correct
                </span>
              </div>
              <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className={`h-full ${tier.color} transition-all`}
                  style={{ width: `${width}%` }}
                />
              </div>
              <div className="mt-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                {tier.label}
                {row.lastSeenAt && ` · last seen ${new Date(row.lastSeenAt).toLocaleString()}`}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
