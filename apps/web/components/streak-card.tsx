'use client';

import { useEffect, useState } from 'react';
import { fetchStreak, streakStatus, type Streak } from '../lib/streaks-client';
import { Skeleton } from './skeleton';

/**
 * Dashboard card surface for the streak. Mirrors the visual weight of
 * the existing "Review" / "Mastery" cards so it sits in the same grid
 * row.
 *
 * Honest framing in the empty state: we don't pretend a 0-day streak
 * is anything. The card explains how to start one and links to /review.
 */
export function StreakCard() {
  const [streak, setStreak] = useState<Streak | null>(null);

  useEffect(() => {
    fetchStreak()
      .then(setStreak)
      .catch(() => undefined);
  }, []);

  if (!streak) {
    return (
      <div
        role="status"
        aria-busy="true"
        aria-label="Loading streak"
        className="rounded-lg border border-border p-5"
      >
        <h2 className="font-medium">Streak</h2>
        <div className="mt-2 flex items-center gap-2">
          <Skeleton className="h-6 w-6 rounded-full" />
          <Skeleton className="h-6 w-10" />
        </div>
        <Skeleton className="mt-3 h-3 w-32" />
      </div>
    );
  }

  const status = streakStatus(streak);
  const toneClass =
    status.tone === 'success'
      ? 'text-emerald-700'
      : status.tone === 'warn'
        ? 'text-amber-700'
        : 'text-muted-foreground';

  return (
    <div className="rounded-lg border border-border p-5">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="font-medium">Streak</h2>
        <span className="text-xs text-muted-foreground">
          best {streak.longestStreak}
        </span>
      </div>
      <p className="mt-1 flex items-center gap-2">
        <FlameIcon
          className={
            streak.currentStreak > 0 ? 'text-amber-600' : 'text-muted-foreground'
          }
        />
        <span className="text-2xl font-semibold tracking-tight">
          {streak.currentStreak}
        </span>
        <span className="text-xs text-muted-foreground">
          day{streak.currentStreak === 1 ? '' : 's'}
        </span>
      </p>
      <p className={`mt-2 text-xs ${toneClass}`}>{status.label}</p>
      {streak.totalActiveDays > 0 && (
        <p className="mt-1 text-[11px] text-muted-foreground">
          {streak.totalActiveDays} active days lifetime
        </p>
      )}
    </div>
  );
}

function FlameIcon({ className }: { className?: string }) {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path d="M12 2s4 4 4 8a4 4 0 0 1-8 0c0-1 0-2 1-3 0 2 1 3 2 3-1-2-1-4 1-6 0-1 0-2 0-2zm-5 13c0-1 1-2 1-2 0 1 1 2 2 2-1-1-1-2 0-3 1 3 4 4 4 7a4 4 0 0 1-8 0c0-2 1-3 1-4z" />
    </svg>
  );
}
