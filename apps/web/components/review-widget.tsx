'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { fetchReviewStats, type ReviewStats } from '../lib/srs-client';

/**
 * Compact dashboard card showing today's review load and a quick-start
 * button. Renders nothing until the stats land so we don't flash placeholder
 * numbers. Honest about empty state — no manufactured urgency when there
 * are no cards.
 */
export function ReviewWidget() {
  const [stats, setStats] = useState<ReviewStats | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchReviewStats()
      .then((s) => {
        if (!cancelled) setStats(s);
      })
      .catch(() => {
        // Swallow — widget just won't render if the stats endpoint errors.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!stats) return null;

  if (stats.totalCards === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-5">
        <h2 className="font-medium">Spaced repetition</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Generate a flashcard deck on any folder — they'll land here for
          daily review.
        </p>
      </div>
    );
  }

  const dueNow = stats.dueNow;
  return (
    <Link
      href="/review"
      className="rounded-lg border border-border p-5 hover:bg-accent"
    >
      <div className="flex items-baseline justify-between">
        <h2 className="font-medium">Review</h2>
        <span
          className={`text-xs font-medium ${dueNow > 0 ? 'text-foreground' : 'text-muted-foreground'}`}
        >
          {dueNow > 0 ? `${dueNow} due` : 'nothing due'}
        </span>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        {dueNow > 0
          ? `Start a session — ${stats.reviewedToday > 0 ? `${stats.reviewedToday} reviewed today, ` : ''}${stats.dueThisWeek} due this week.`
          : `${stats.reviewedToday} reviewed today · ${stats.dueThisWeek} due this week.`}
      </p>
    </Link>
  );
}
