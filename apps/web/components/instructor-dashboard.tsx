'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { apiGetCachedWithMeta, ApiError } from '../lib/dev-fetch';
import { formatCacheAge } from '../lib/format-cache-age';
import { FeatureFlagsPanel } from './feature-flags-panel';

interface Overview {
  courses: number;
  documents: number;
  students: number;
  quizAttempts: number;
  avgScore: number | null;
  abusePending: number;
}

interface CourseRow {
  id: string;
  title: string;
  studentCount: number;
  documentCount: number;
  deckCount: number;
  quizCount: number;
  conceptCount: number;
  avgMastery: number | null;
}

interface AbuseRow {
  id: string;
  s3Key: string;
  state: string;
  flags: string[];
  createdAt: string;
  userId: string;
}

function pct(x: number | null): string {
  return x === null ? '—' : `${Math.round(x * 100)}%`;
}

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-border p-4">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
      {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

export function InstructorDashboard() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [courses, setCourses] = useState<CourseRow[]>([]);
  const [abuse, setAbuse] = useState<AbuseRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const tc = useTranslations('common');
  // Offline-cache surface, parity with the roadmap + concept-graph
  // viewers (D-0b / D-3). The dashboard hits 3 endpoints; we show ONE
  // banner using the OLDEST cached snapshot so the instructor never
  // thinks "Courses is from 2 minutes ago but Abuse is from yesterday."
  const [oldestCachedAt, setOldestCachedAt] = useState<number | null>(null);
  const [anyFromCache, setAnyFromCache] = useState(false);

  const refresh = async () => {
    setError(null);
    try {
      const [o, c, a] = await Promise.all([
        apiGetCachedWithMeta<Overview>('/v1/instructor/overview'),
        apiGetCachedWithMeta<{ courses: CourseRow[] }>('/v1/instructor/courses'),
        apiGetCachedWithMeta<{ items: AbuseRow[] }>('/v1/instructor/abuse'),
      ]);
      setOverview(o.value);
      setCourses(c.value.courses);
      setAbuse(a.value.items);

      const cached = [o, c, a].filter((r) => r.fromCache);
      setAnyFromCache(cached.length > 0);
      if (cached.length === 0) {
        setOldestCachedAt(null);
      } else {
        // ``Math.min`` of the available timestamps — the oldest snapshot
        // is what determines the trust level. ``null`` ts is skipped.
        const tsList = cached
          .map((r) => r.cachedAt)
          .filter((v): v is number => typeof v === 'number');
        setOldestCachedAt(tsList.length > 0 ? Math.min(...tsList) : null);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load instructor data');
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  return (
    <div className="space-y-8">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Instructor</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Cohort engagement, mastery, and the abuse-review queue. Data is
            scoped to your tenant.
          </p>
        </div>
        <button
          onClick={() => void refresh()}
          className="rounded-md border border-border px-3 py-1 text-xs hover:bg-accent"
        >
          {tc('refresh')}
        </button>
      </header>

      {error && <p className="text-xs text-red-500">{error}</p>}

      {anyFromCache && (
        <div
          role="status"
          className="rounded-md border border-amber-400/60 bg-amber-50/70 px-3 py-2 text-xs text-amber-900 dark:bg-amber-900/15 dark:text-amber-200"
        >
          {oldestCachedAt ? (
            <>
              Viewing cached cohort data from at least{' '}
              {formatCacheAge(oldestCachedAt)} ago. The fresh figures load
              when you're back online — hit Refresh to retry.
            </>
          ) : (
            <>
              Viewing cached cohort data. The fresh figures load when you're
              back online — hit Refresh to retry.
            </>
          )}
        </div>
      )}

      {overview && (
        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="Courses" value={overview.courses.toString()} />
          <StatCard label="Documents" value={overview.documents.toString()} />
          <StatCard label="Students" value={overview.students.toString()} />
          <StatCard
            label="Avg quiz score"
            value={pct(overview.avgScore)}
            hint={`${overview.quizAttempts} attempt${overview.quizAttempts === 1 ? '' : 's'}`}
          />
        </section>
      )}

      <section className="space-y-3">
        <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          Courses
        </h2>
        {courses.length === 0 ? (
          <p className="rounded-md border border-dashed border-border p-4 text-xs text-muted-foreground">
            No courses yet.
          </p>
        ) : (
          <div className="overflow-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/30 text-[11px] uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 text-left">Title</th>
                  <th className="px-4 py-2 text-right">Students</th>
                  <th className="px-4 py-2 text-right">Docs</th>
                  <th className="px-4 py-2 text-right">Decks</th>
                  <th className="px-4 py-2 text-right">Quizzes</th>
                  <th className="px-4 py-2 text-right">Concepts</th>
                  <th className="px-4 py-2 text-right">Mastery</th>
                </tr>
              </thead>
              <tbody>
                {courses.map((c) => (
                  <tr key={c.id} className="border-t border-border">
                    <td className="px-4 py-2 font-medium">{c.title}</td>
                    <td className="px-4 py-2 text-right">{c.studentCount}</td>
                    <td className="px-4 py-2 text-right">{c.documentCount}</td>
                    <td className="px-4 py-2 text-right">{c.deckCount}</td>
                    <td className="px-4 py-2 text-right">{c.quizCount}</td>
                    <td className="px-4 py-2 text-right">{c.conceptCount}</td>
                    <td className="px-4 py-2 text-right">{pct(c.avgMastery)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          Abuse review
          {overview && overview.abusePending > 0 && (
            <span className="ml-2 rounded-full bg-rose-500/10 px-2 py-0.5 text-[10px] text-rose-700">
              {overview.abusePending} pending
            </span>
          )}
        </h2>
        {abuse.length === 0 ? (
          <p className="rounded-md border border-dashed border-border p-4 text-xs text-muted-foreground">
            No flagged uploads. The safety pipeline tags `injection`, `pii`,
            `policy`, or `corruption` as findings ship.
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {abuse.map((a) => (
              <li key={a.id} className="px-4 py-3 text-sm">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="font-medium">{a.s3Key.split('/').pop()}</span>
                  <time className="text-[10px] text-muted-foreground">
                    {new Date(a.createdAt).toLocaleString()}
                  </time>
                </div>
                <div className="mt-1 flex gap-2 text-xs">
                  <span className="rounded-sm bg-rose-500/10 px-2 py-0.5 text-rose-700">
                    state: {a.state}
                  </span>
                  {a.flags.map((f) => (
                    <span
                      key={f}
                      className="rounded-sm bg-amber-500/10 px-2 py-0.5 text-amber-700"
                    >
                      {f}
                    </span>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <FeatureFlagsPanel />
    </div>
  );
}
