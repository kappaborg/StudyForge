'use client';

import { useEffect, useState } from 'react';
import { track } from '../lib/analytics';
import { apiGetCachedWithMeta, apiPost, ApiError } from '../lib/dev-fetch';
import { formatCacheAge } from '../lib/format-cache-age';
import { relativeTime } from '../lib/format-document';

interface Milestone {
  id: string;
  weekIndex: number;
  ordinal: number;
  title: string;
  effortMin: number;
  status: string;
}

interface Roadmap {
  id: string;
  title: string;
  weeks: number;
  milestones: Milestone[];
}

interface RoadmapSummary {
  id: string;
  title: string;
  weeks: number;
  milestoneCount: number;
  createdAt: string;
}

export function RoadmapPanel({ courseId }: { courseId: string }) {
  const [roadmaps, setRoadmaps] = useState<RoadmapSummary[]>([]);
  const [roadmap, setRoadmap] = useState<Roadmap | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [weeks, setWeeks] = useState(4);

  // Offline-state for the read-only roadmap views. ``listFromCache``
  // tracks the index (LHS rail); ``detailCachedAt`` tracks the opened
  // roadmap (RHS body). Showing both lets the student tell at a glance
  // whether their LIST is stale, their DETAIL is stale, or both.
  const [listFromCache, setListFromCache] = useState(false);
  const [listCachedAt, setListCachedAt] = useState<number | null>(null);
  const [detailFromCache, setDetailFromCache] = useState(false);
  const [detailCachedAt, setDetailCachedAt] = useState<number | null>(null);

  const refresh = async () => {
    try {
      const res = await apiGetCachedWithMeta<{ roadmaps: RoadmapSummary[] }>(
        `/v1/courses/${courseId}/roadmaps`,
      );
      setRoadmaps(res.value.roadmaps);
      setListFromCache(res.fromCache);
      setListCachedAt(res.cachedAt);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load roadmaps');
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseId]);

  const onGenerate = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await apiPost<Roadmap>('/v1/roadmaps/generate', {
        courseId,
        query: query.trim() || undefined,
        weeks,
      });
      setRoadmap(res);
      track('roadmap.generated', { courseId, weeks: res.weeks, roadmapId: res.id });
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Generation failed');
    } finally {
      setBusy(false);
    }
  };

  const openRoadmap = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await apiGetCachedWithMeta<Roadmap>(`/v1/roadmaps/${id}`);
      setRoadmap(res.value);
      setDetailFromCache(res.fromCache);
      setDetailCachedAt(res.cachedAt);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to open roadmap');
    } finally {
      setBusy(false);
    }
  };

  const byWeek = new Map<number, Milestone[]>();
  if (roadmap) {
    for (const m of roadmap.milestones) {
      const arr = byWeek.get(m.weekIndex) ?? [];
      arr.push(m);
      byWeek.set(m.weekIndex, arr);
    }
  }

  // Single banner that prefers whichever surface is more meaningful to
  // the student right now: a stale detail view trumps a stale list,
  // since detail is what they're actively reading.
  const offlineSurface = detailFromCache
    ? { label: 'this roadmap', cachedAt: detailCachedAt }
    : listFromCache
      ? { label: 'the roadmap list', cachedAt: listCachedAt }
      : null;

  return (
    <div className="space-y-6">
      {offlineSurface && (
        <div
          role="status"
          className="rounded-md border border-amber-400/60 bg-amber-50/70 px-3 py-2 text-xs text-amber-900 dark:bg-amber-900/15 dark:text-amber-200"
        >
          {offlineSurface.cachedAt ? (
            <>
              You're viewing {offlineSurface.label} from a cached snapshot{' '}
              {formatCacheAge(offlineSurface.cachedAt)} ago. The fresh
              version will load when you're back online.
            </>
          ) : (
            <>
              You're viewing {offlineSurface.label} from a cached snapshot.
              The fresh version will load when you're back online.
            </>
          )}
        </div>
      )}
      <section className="rounded-lg border border-border p-4 space-y-3">
        <h3 className="text-sm font-semibold">Generate a new roadmap</h3>
        <div className="flex flex-col gap-2 md:flex-row md:items-end">
          <div className="flex-1">
            <label className="text-xs text-muted-foreground">Focus (optional)</label>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="leave empty for end-to-end coverage"
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            />
          </div>
          <div className="w-24">
            <label className="text-xs text-muted-foreground">Weeks</label>
            <input
              type="number"
              min={1}
              max={16}
              value={weeks}
              onChange={(e) => setWeeks(Math.max(1, Math.min(16, Number(e.target.value) || 1)))}
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            />
          </div>
          <button
            onClick={() => void onGenerate()}
            disabled={busy}
            className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background hover:opacity-90 disabled:opacity-50"
          >
            {busy ? 'Planning…' : 'Generate'}
          </button>
        </div>
        {error && <p className="text-xs text-red-500">{error}</p>}
      </section>

      {roadmaps.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Your roadmaps
          </h3>
          <ul className="divide-y divide-border rounded-md border border-border">
            {roadmaps.map((r) => (
              <li key={r.id} className="flex items-center justify-between px-4 py-3 text-sm">
                <div>
                  <div className="font-medium">{r.title}</div>
                  <div className="text-xs text-muted-foreground">
                    {r.weeks} weeks · {r.milestoneCount} milestones · created{' '}
                    {relativeTime(r.createdAt)}
                  </div>
                </div>
                <button
                  onClick={() => void openRoadmap(r.id)}
                  className="rounded-md border border-border px-3 py-1 text-xs hover:bg-accent"
                >
                  Open
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {roadmap && (
        <section className="space-y-3">
          <header className="flex items-baseline justify-between">
            <h3 className="text-sm font-semibold">{roadmap.title}</h3>
            <span className="text-xs text-muted-foreground">{roadmap.weeks} weeks</span>
          </header>
          <div className="grid gap-3 md:grid-cols-2">
            {Array.from({ length: roadmap.weeks }, (_, i) => i + 1).map((w) => {
              const ms = (byWeek.get(w) ?? []).sort((a, b) => a.ordinal - b.ordinal);
              const totalEffort = ms.reduce((acc, m) => acc + m.effortMin, 0);
              return (
                <article key={w} className="rounded-lg border border-border p-4">
                  <header className="flex items-baseline justify-between">
                    <h4 className="text-sm font-semibold">Week {w}</h4>
                    <span className="text-xs text-muted-foreground">
                      {totalEffort > 0 ? `${totalEffort} min` : '—'}
                    </span>
                  </header>
                  {ms.length === 0 ? (
                    <p className="mt-2 text-xs text-muted-foreground">No milestones.</p>
                  ) : (
                    <ol className="mt-3 space-y-2">
                      {ms.map((m) => (
                        <li key={m.id} className="rounded-md bg-muted/30 px-3 py-2 text-sm">
                          <div className="font-medium">{m.title}</div>
                          <div className="mt-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                            ~{m.effortMin} min · {m.status}
                          </div>
                        </li>
                      ))}
                    </ol>
                  )}
                </article>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
