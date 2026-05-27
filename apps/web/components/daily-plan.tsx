'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { listExamScopes, type ExamScopeRow } from '../lib/exam-scopes-client';
import { fetchWeakest, type MasteryRow } from '../lib/mastery-client';
import { fetchReviewStats, type ReviewStats } from '../lib/srs-client';
import { buildDailyPlan, type PlanItem } from '../lib/daily-plan';
import { Skeleton } from './skeleton';

/**
 * Surfaces a deterministic ~45-minute plan composed from data the
 * dashboard already pulls. No persistence — refreshing regenerates from
 * current state, so progress shows up naturally (a card you just
 * reviewed drops out of the review slot, etc.).
 *
 * "Done" toggles are session-local: they reset when the user navigates
 * away. That's intentional — we don't want stale "done" ticks claiming
 * credit for work the user didn't do today.
 */
export function DailyPlan() {
  const [stats, setStats] = useState<ReviewStats | null>(null);
  const [scopes, setScopes] = useState<ExamScopeRow[] | null>(null);
  const [weakest, setWeakest] = useState<MasteryRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [doneSet, setDoneSet] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchReviewStats(), listExamScopes(), fetchWeakest(3)])
      .then(([s, sc, wk]) => {
        if (cancelled) return;
        setStats(s);
        setScopes(sc);
        setWeakest(wk);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Could not load plan');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const plan: PlanItem[] | null = useMemo(() => {
    if (!stats || !scopes || !weakest) return null;
    return buildDailyPlan({ reviewStats: stats, scopes, weakest });
  }, [stats, scopes, weakest]);

  if (error) {
    return (
      <section className="rounded-lg border border-border p-5">
        <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          Today's plan
        </h2>
        <p className="mt-2 rounded bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</p>
      </section>
    );
  }

  const totalMin = plan?.reduce((s, p) => s + p.minutes, 0) ?? 0;

  return (
    <section className="rounded-lg border border-border p-5">
      <header className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          Today's plan
        </h2>
        {plan && (
          <span className="text-xs text-muted-foreground">
            ~{totalMin} min · {plan.length} task{plan.length === 1 ? '' : 's'}
          </span>
        )}
      </header>

      {!plan ? (
        <ol
          role="status"
          aria-busy="true"
          aria-label="Composing your day"
          className="mt-3 space-y-2"
        >
          {Array.from({ length: 3 }).map((_, i) => (
            <li
              key={i}
              className="flex items-start gap-3 rounded-md border border-border p-3"
            >
              <Skeleton className="mt-0.5 h-5 w-5 flex-shrink-0" />
              <div className="min-w-0 flex-1 space-y-2">
                <Skeleton className="h-3 w-2/3" />
                <Skeleton className="h-2 w-1/2" />
              </div>
              <Skeleton className="h-6 w-14 flex-shrink-0" />
            </li>
          ))}
        </ol>
      ) : (
        <ol className="mt-3 space-y-2">
          {plan.map((item, i) => {
            const id = `${item.kind}:${i}`;
            const done = doneSet.has(id);
            return (
              <li
                key={id}
                className={`flex items-start gap-3 rounded-md border border-border p-3 ${
                  done ? 'opacity-60' : ''
                }`}
              >
                <button
                  type="button"
                  onClick={() =>
                    setDoneSet((prev) => {
                      const next = new Set(prev);
                      if (next.has(id)) next.delete(id);
                      else next.add(id);
                      return next;
                    })
                  }
                  aria-label={done ? 'Mark not done' : 'Mark done'}
                  className={`mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded border ${
                    done
                      ? 'border-emerald-500 bg-emerald-500 text-white'
                      : 'border-border text-transparent hover:border-foreground'
                  }`}
                >
                  ✓
                </button>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className={`text-sm font-medium ${done ? 'line-through' : ''}`}>
                      {item.label}
                    </p>
                    <span className="text-[11px] text-muted-foreground">~{item.minutes} min</span>
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">{item.hint}</p>
                </div>
                <Link
                  href={item.href}
                  className="rounded-md border border-border px-3 py-1 text-xs font-medium hover:bg-accent"
                >
                  Start
                </Link>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
