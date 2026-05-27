'use client';

import { apiGet } from './dev-fetch';

export interface Streak {
  currentStreak: number;
  longestStreak: number;
  totalActiveDays: number;
  lastActiveDate: string | null;
  active: boolean; // true == already counted today
}

export async function fetchStreak(): Promise<Streak> {
  return apiGet<Streak>('/v1/streaks/me');
}

/**
 * Pretty status copy for the dashboard card. We hand-roll this rather
 * than pull in a date library — `Intl.RelativeTimeFormat` covers the
 * three cases we actually surface ("today", "yesterday", "broken").
 */
export function streakStatus(s: Streak): {
  label: string;
  tone: 'success' | 'warn' | 'muted';
} {
  if (s.currentStreak === 0) {
    return { label: 'No streak yet — review a card or take a quiz to start one.', tone: 'muted' };
  }
  if (s.active) {
    return { label: 'Active today — see you tomorrow!', tone: 'success' };
  }
  // Active yesterday: still alive, but at risk if user closes the tab.
  return { label: 'At risk — do one review today to keep your streak alive.', tone: 'warn' };
}
