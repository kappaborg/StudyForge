'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { track } from '../lib/analytics';
import { useTranslations } from 'next-intl';
import { formatCacheAge } from '../lib/format-cache-age';
import {
  fetchDueCards,
  flushQueuedGrades,
  formatInterval,
  gradeCard,
  GRADES,
  pendingGradeCount,
  type ReviewableCard,
  type ReviewResult,
} from '../lib/srs-client';
import { Skeleton } from './skeleton';

interface SessionStats {
  reviewed: number;
  again: number;
  hard: number;
  good: number;
  easy: number;
}

/**
 * Full-page spaced-repetition review session.
 *
 * Loads up to 20 due/new cards in one pull, then walks the user through
 * them one at a time. Each card has two phases:
 *
 *   1. Front shown, "Show answer" button (or space)
 *   2. Back revealed, four grade buttons (or 1/2/3/4)
 *
 * Grading sends a POST to /v1/flashcards/:id/review which advances the
 * SM-2 state server-side. We optimistically advance the local queue so
 * the next card appears immediately; the server-side schedule update is
 * fire-and-forget from the UI's perspective.
 */
export function ReviewSession() {
  const [queue, setQueue] = useState<ReviewableCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const tc = useTranslations('common');
  const [stats, setStats] = useState<SessionStats>({
    reviewed: 0,
    again: 0,
    hard: 0,
    good: 0,
    easy: 0,
  });
  const [lastResult, setLastResult] = useState<{
    grade: string;
    next: ReviewResult | null;
  } | null>(null);

  // Offline-mode UI state — Phase 3 §10. Three signals the user cares about:
  //   * ``fromCache``: cards came from IDB, not the network
  //   * ``cachedAt``: when that cache was last refreshed
  //   * ``pendingCount``: how many grades are queued waiting to sync
  const [fromCache, setFromCache] = useState(false);
  const [cachedAt, setCachedAt] = useState<number | null>(null);
  const [pendingCount, setPendingCount] = useState(0);

  const refreshPendingCount = useCallback(async () => {
    setPendingCount(await pendingGradeCount());
  }, []);

  const loadQueue = useCallback(async () => {
    try {
      const result = await fetchDueCards(20);
      setQueue(result.cards);
      setFromCache(result.fromCache);
      setCachedAt(result.cachedAt);
      setRevealed(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load cards');
    }
  }, []);

  useEffect(() => {
    void loadQueue();
    void refreshPendingCount();
  }, [loadQueue, refreshPendingCount]);

  // Drain the offline grade queue when the browser tells us we're back
  // online. Also a manual button below covers the case where the
  // ``online`` event fires before the React tree has mounted.
  useEffect(() => {
    const onOnline = async () => {
      const outcome = await flushQueuedGrades();
      if (outcome.succeeded > 0 || outcome.failed > 0) {
        await refreshPendingCount();
      }
    };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [refreshPendingCount]);

  const current = queue?.[0];

  const grade = useCallback(
    async (quality: number, key: string) => {
      if (!current || busy) return;
      setBusy(true);
      try {
        const outcome = await gradeCard(current.id, quality);
        track('srs.reviewed', {
          flashcardId: current.id,
          quality,
          // ``intervalDays`` is -1 when the grade was queued offline so
          // analytics' typed schema stays a number (sentinel value).
          intervalDays: outcome.result?.intervalDays ?? -1,
          queued: outcome.queued,
        });
        if (outcome.queued) {
          // Offline path — refresh the pending count so the badge updates.
          await refreshPendingCount();
        }
        setLastResult({ grade: key, next: outcome.result });
        setStats((s) => ({
          reviewed: s.reviewed + 1,
          again: s.again + (key === 'Again' ? 1 : 0),
          hard: s.hard + (key === 'Hard' ? 1 : 0),
          good: s.good + (key === 'Good' ? 1 : 0),
          easy: s.easy + (key === 'Easy' ? 1 : 0),
        }));
        // If "Again", re-queue this card at the end so the user sees it
        // again before the session ends — that's how Anki handles lapses
        // and it dramatically helps retention.
        setQueue((prev) => {
          if (!prev) return prev;
          const [head, ...rest] = prev;
          if (!head) return rest;
          return key === 'Again' ? [...rest, head] : rest;
        });
        setRevealed(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Review failed');
      } finally {
        setBusy(false);
      }
    },
    [current, busy, refreshPendingCount],
  );

  // Keyboard shortcuts: space to reveal, 1-4 to grade.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!current) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (!revealed) {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          setRevealed(true);
        }
        return;
      }
      const idx = ['1', '2', '3', '4'].indexOf(e.key);
      if (idx >= 0) {
        e.preventDefault();
        const g = GRADES[idx];
        if (g) void grade(g.quality, g.key);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [revealed, current, grade]);

  // ── render states ─────────────────────────────────────────────────────────

  if (error) {
    return (
      <main className="mx-auto max-w-2xl py-12">
        <p className="rounded bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</p>
        <button
          type="button"
          onClick={() => {
            setError(null);
            void loadQueue();
          }}
          className="mt-3 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent"
        >
          {tc('tryAgain')}
        </button>
      </main>
    );
  }

  if (queue === null) {
    return (
      <main
        role="status"
        aria-busy="true"
        aria-label="Loading review session"
        className="mx-auto flex max-w-2xl flex-col gap-6 px-3 py-6 sm:px-0 sm:py-10"
      >
        <header className="space-y-2">
          <Skeleton className="h-5 w-1/3" />
          <Skeleton className="h-1 w-full rounded-full" />
        </header>
        <article className="space-y-4 rounded-lg border border-border p-6">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-5 w-3/4" />
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="mt-4 h-9 w-32" />
        </article>
      </main>
    );
  }

  if (queue.length === 0) {
    return (
      <main className="mx-auto max-w-xl space-y-6 py-16 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">All caught up</h1>
        {stats.reviewed > 0 ? (
          <SessionSummary stats={stats} />
        ) : (
          <p className="text-sm text-muted-foreground">
            No cards are due right now. Generate a flashcard deck on any folder
            and they'll show up here for review.
          </p>
        )}
        <div className="flex justify-center gap-2">
          <Link
            href="/dashboard"
            className="rounded-md border border-border px-4 py-2 text-sm hover:bg-accent"
          >
            Back to dashboard
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 px-3 py-6 sm:px-0 sm:py-10">
      <OfflineStatusBar
        fromCache={fromCache}
        cachedAt={cachedAt}
        pendingCount={pendingCount}
        onManualSync={async () => {
          await flushQueuedGrades();
          await refreshPendingCount();
        }}
      />
      <header className="space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="text-base font-semibold tracking-tight sm:text-lg">Review · {current?.deckTitle}</h1>
          <p className="text-xs text-muted-foreground">
            {stats.reviewed} done · {queue.length} left
          </p>
        </div>
        <div
          className="h-1 w-full overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-label="Session progress"
          aria-valuenow={stats.reviewed}
          aria-valuemin={0}
          aria-valuemax={stats.reviewed + queue.length}
        >
          <div
            className="h-full bg-foreground transition-all"
            style={{
              width: `${
                stats.reviewed + queue.length === 0
                  ? 0
                  : Math.round((stats.reviewed / (stats.reviewed + queue.length)) * 100)
              }%`,
            }}
          />
        </div>
      </header>

      {current && (
        <article className="rounded-lg border border-border bg-background p-6 shadow-sm">
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
            Question
          </p>
          <p className="mt-2 whitespace-pre-wrap text-lg leading-relaxed">{current.front}</p>

          {revealed ? (
            <>
              <hr className="my-6 border-border" />
              <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
                Answer
              </p>
              <p className="mt-2 whitespace-pre-wrap text-base leading-relaxed">
                {current.back}
              </p>
              <p className="mt-3 text-[11px] text-muted-foreground">
                {current.reviewCount === 0
                  ? 'New card'
                  : `Reviewed ${current.reviewCount} time${current.reviewCount === 1 ? '' : 's'} · last interval ${formatInterval(current.intervalDays)}`}
              </p>
            </>
          ) : (
            <div className="mt-6">
              <button
                type="button"
                onClick={() => setRevealed(true)}
                className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background hover:opacity-90"
              >
                Show answer <span className="ml-2 text-xs opacity-60">(space)</span>
              </button>
            </div>
          )}
        </article>
      )}

      {revealed && current && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {GRADES.map((g) => (
            <button
              key={g.key}
              type="button"
              disabled={busy}
              onClick={() => void grade(g.quality, g.key)}
              className={`flex flex-col items-center gap-1 rounded-md border px-3 py-3 text-sm transition-colors disabled:opacity-50 ${gradeStyle(g.color)}`}
            >
              <span className="font-medium">{g.key}</span>
              <span className="text-[10px] opacity-70">
                {nextLabelFor(g.quality, current)}
              </span>
              <span className="text-[10px] opacity-50">{g.shortcut}</span>
            </button>
          ))}
        </div>
      )}

      {lastResult && (
        <p className="text-[11px] text-muted-foreground">
          {lastResult.next === null ? (
            <>Last: {lastResult.grade} → queued (will sync when online)</>
          ) : (
            <>
              Last: {lastResult.grade} → next in{' '}
              {formatInterval(lastResult.next.intervalDays)}
              {lastResult.next.lapsed && ' · lapse recorded'}
            </>
          )}
        </p>
      )}
    </main>
  );
}

interface OfflineStatusBarProps {
  fromCache: boolean;
  cachedAt: number | null;
  pendingCount: number;
  onManualSync: () => Promise<void>;
}

/**
 * Thin top-of-page banner that surfaces the offline review surface to
 * the student. Nothing renders when the network is fresh AND no grades
 * are queued — the common case. Otherwise we show the freshest piece of
 * status: cached-queue notice + age, or queued-sync count + manual
 * trigger button.
 */
function OfflineStatusBar({
  fromCache,
  cachedAt,
  pendingCount,
  onManualSync,
}: OfflineStatusBarProps) {
  if (!fromCache && pendingCount === 0) return null;
  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-400/60 bg-amber-50/70 px-3 py-2 text-xs text-amber-900 dark:bg-amber-900/15 dark:text-amber-200"
    >
      <span>
        {fromCache && cachedAt ? (
          <>
            Reviewing cached queue from {formatCacheAge(cachedAt)} ago — your
            grades save locally and will sync when you're back online.
          </>
        ) : (
          <>
            {pendingCount} grade{pendingCount === 1 ? '' : 's'} queued — will
            sync when you're back online.
          </>
        )}
      </span>
      {pendingCount > 0 && (
        <button
          type="button"
          onClick={() => void onManualSync()}
          className="rounded-md border border-amber-400/80 px-2 py-0.5 font-medium hover:bg-amber-100/80 dark:hover:bg-amber-900/30"
        >
          Sync now
        </button>
      )}
    </div>
  );
}

function SessionSummary({ stats }: { stats: SessionStats }) {
  return (
    <div className="space-y-2 rounded-md border border-border p-4">
      <p className="text-sm">
        Reviewed <span className="font-medium">{stats.reviewed}</span> card
        {stats.reviewed === 1 ? '' : 's'} this session.
      </p>
      <p className="text-xs text-muted-foreground">
        Again {stats.again} · Hard {stats.hard} · Good {stats.good} · Easy {stats.easy}
      </p>
    </div>
  );
}

function gradeStyle(color: string): string {
  switch (color) {
    case 'rose':
      return 'border-rose-300 hover:bg-rose-50 text-rose-700';
    case 'amber':
      return 'border-amber-300 hover:bg-amber-50 text-amber-700';
    case 'emerald':
      return 'border-emerald-300 hover:bg-emerald-50 text-emerald-700';
    case 'sky':
      return 'border-sky-300 hover:bg-sky-50 text-sky-700';
    default:
      return 'border-border hover:bg-accent';
  }
}

// Approximate "next interval" preview so the student sees the consequence
// of each grade BEFORE clicking. Mirrors srs.service.ts/nextIntervalDays
// but with light fudge — exact numbers come back from the POST response.
function nextLabelFor(quality: number, card: ReviewableCard): string {
  if (quality < 3) return '< 1 day';
  if (card.reviewCount === 0) return '1 day';
  if (card.reviewCount === 1) return '~6 days';
  const days = Math.round(card.intervalDays * card.easeFactor);
  return formatInterval(days);
}
