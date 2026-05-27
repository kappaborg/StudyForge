'use client';

import { useEffect, useMemo, useState } from 'react';
import { relativeTime } from '../lib/format-document';
import { fetchMastery, type MasteryRow } from '../lib/mastery-client';
import { SkeletonCardGrid } from './skeleton';

/**
 * Per-concept mastery tiles, grouped by course/folder. Each tile shows the
 * mastery bar, attempts, and time since last seen. Rows with zero attempts
 * are folded under "Not yet practiced" so the main grid stays focused on
 * concepts you've actually engaged with.
 */
export function MasteryGrid() {
  const [rows, setRows] = useState<MasteryRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchMastery()
      .then(setRows)
      .catch((err) => setError(err instanceof Error ? err.message : 'Load failed'));
  }, []);

  const { byCourse, untried } = useMemo(() => {
    const byCourse = new Map<string, { title: string; rows: MasteryRow[] }>();
    const untried: MasteryRow[] = [];
    for (const r of rows ?? []) {
      if (r.attempts === 0) {
        untried.push(r);
        continue;
      }
      const bucket = byCourse.get(r.courseId) ?? { title: r.courseTitle, rows: [] };
      bucket.rows.push(r);
      byCourse.set(r.courseId, bucket);
    }
    for (const bucket of byCourse.values()) {
      bucket.rows.sort((a, b) => a.mastery - b.mastery);
    }
    return { byCourse, untried };
  }, [rows]);

  if (error) {
    return <p className="rounded bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</p>;
  }
  if (rows === null) {
    return <SkeletonCardGrid count={4} className="grid gap-2 sm:grid-cols-2" />;
  }
  if (rows.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-border p-6 text-center text-xs text-muted-foreground">
        No mastery data yet. Take a quiz (any folder, "Quizzes" tab) and your
        per-concept progress shows up here.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      {Array.from(byCourse.entries()).map(([courseId, { title, rows: bucket }]) => (
        <section key={courseId}>
          <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {title}
          </h3>
          <ul className="mt-2 grid gap-2 sm:grid-cols-2">
            {bucket.map((r) => (
              <MasteryTile key={r.conceptId} row={r} />
            ))}
          </ul>
        </section>
      ))}
      {untried.length > 0 && (
        <details className="rounded-md border border-dashed border-border p-3">
          <summary className="cursor-pointer text-xs text-muted-foreground">
            {untried.length} concept{untried.length === 1 ? '' : 's'} not yet practiced
          </summary>
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {untried.map((r) => (
              <li
                key={r.conceptId}
                className="rounded bg-muted px-2 py-0.5 text-[11px] text-muted-foreground"
              >
                {r.label}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function MasteryTile({ row }: { row: MasteryRow }) {
  const pct = Math.round(row.mastery * 100);
  const tone =
    pct >= 75 ? 'emerald' : pct >= 45 ? 'sky' : pct >= 20 ? 'amber' : 'rose';
  return (
    <li className="rounded-md border border-border p-3">
      <div className="flex items-baseline justify-between">
        <span className="truncate text-sm font-medium">{row.label}</span>
        <span className={`text-xs font-semibold ${toneText(tone)}`}>{pct}%</span>
      </div>
      <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full transition-all ${toneBar(tone)}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">
        {row.correct}/{row.attempts} correct ·{' '}
        {row.lastSeenAt ? `last seen ${relativeTime(row.lastSeenAt)}` : 'no recent attempt'}
      </p>
    </li>
  );
}

function toneText(t: string): string {
  return t === 'emerald'
    ? 'text-emerald-700'
    : t === 'sky'
      ? 'text-sky-700'
      : t === 'amber'
        ? 'text-amber-700'
        : 'text-rose-700';
}

function toneBar(t: string): string {
  return t === 'emerald'
    ? 'bg-emerald-500'
    : t === 'sky'
      ? 'bg-sky-500'
      : t === 'amber'
        ? 'bg-amber-500'
        : 'bg-rose-500';
}

