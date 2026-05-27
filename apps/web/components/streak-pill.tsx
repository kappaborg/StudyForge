'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { fetchStreak, type Streak } from '../lib/streaks-client';

/**
 * Compact streak indicator for the desktop header. Hidden until the
 * stats land so the header doesn't shift. Renders nothing if the user
 * has never been active — no point flashing "0" on a fresh signup.
 *
 * Refreshes on window focus so a streak gained mid-review session
 * shows up the moment the user navigates back to a page that has the
 * header (without forcing a refetch on every route change).
 */
export function StreakPill() {
  const [streak, setStreak] = useState<Streak | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const s = await fetchStreak();
        if (!cancelled) setStreak(s);
      } catch {
        // Silently hide on error.
      }
    };
    void load();
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  if (!streak || streak.currentStreak <= 0) return null;

  const at_risk = !streak.active && streak.currentStreak > 0;
  return (
    <Link
      href="/dashboard"
      title={`Current streak: ${streak.currentStreak} day${streak.currentStreak === 1 ? '' : 's'} · best ${streak.longestStreak}${
        at_risk ? ' · review today to keep it' : ''
      }`}
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
        at_risk
          ? 'bg-amber-100 text-amber-800 hover:bg-amber-200'
          : 'bg-orange-100 text-orange-800 hover:bg-orange-200'
      }`}
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="currentColor"
        aria-hidden="true"
      >
        <path d="M12 2s4 4 4 8a4 4 0 0 1-8 0c0-1 0-2 1-3 0 2 1 3 2 3-1-2-1-4 1-6 0-1 0-2 0-2zm-5 13c0-1 1-2 1-2 0 1 1 2 2 2-1-1-1-2 0-3 1 3 4 4 4 7a4 4 0 0 1-8 0c0-2 1-3 1-4z" />
      </svg>
      <span>{streak.currentStreak}</span>
    </Link>
  );
}
