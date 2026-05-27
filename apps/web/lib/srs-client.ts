'use client';

import { API_BASE, DEV_TENANT_ID, DEV_USER_EMAIL, DEV_USER_ID, apiGet } from './dev-fetch';

export interface ReviewableCard {
  id: string;
  front: string;
  back: string;
  deckId: string;
  deckTitle: string;
  intervalDays: number;
  easeFactor: number;
  reviewCount: number;
  lastReviewedAt: string | null;
}

export interface ReviewStats {
  dueNow: number;
  dueToday: number;
  dueThisWeek: number;
  totalCards: number;
  reviewedToday: number;
}

export interface ReviewResult {
  intervalDays: number;
  easeFactor: number;
  dueAt: string;
  reviewCount: number;
  lapsed: boolean;
}

export async function fetchDueCards(limit = 20): Promise<ReviewableCard[]> {
  const res = await apiGet<{ cards: ReviewableCard[] }>(
    `/v1/flashcards/due?limit=${limit}`,
  );
  return res.cards;
}

export async function fetchReviewStats(): Promise<ReviewStats> {
  return apiGet<ReviewStats>('/v1/flashcards/review-stats');
}

export async function gradeCard(
  cardId: string,
  quality: number,
): Promise<ReviewResult> {
  const res = await fetch(`${API_BASE}/v1/flashcards/${cardId}/review`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-tenant-id': DEV_TENANT_ID,
      'x-user-id': DEV_USER_ID,
      'x-user-email': DEV_USER_EMAIL,
    },
    body: JSON.stringify({ quality }),
    credentials: 'include',
  });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 200);
    throw new Error(text || `HTTP ${res.status}`);
  }
  return (await res.json()) as ReviewResult;
}

/**
 * UI → SM-2 quality mapping. Four buttons is the sweet spot — six options
 * (the raw SM-2 scale) slows reviews without improving the model.
 *
 *   Again  → 1  (wrong, reset interval)
 *   Hard   → 3  (correct with effort, small interval bump)
 *   Good   → 4  (correct, standard interval)
 *   Easy   → 5  (perfect, bigger interval bump)
 */
export const GRADES = [
  { key: 'Again', quality: 1, color: 'rose', shortcut: '1' },
  { key: 'Hard', quality: 3, color: 'amber', shortcut: '2' },
  { key: 'Good', quality: 4, color: 'emerald', shortcut: '3' },
  { key: 'Easy', quality: 5, color: 'sky', shortcut: '4' },
] as const;

export function formatInterval(days: number): string {
  if (days < 1) return 'today';
  if (days === 1) return '1 day';
  if (days < 7) return `${days} days`;
  if (days < 30) return `${Math.round(days / 7)} weeks`;
  if (days < 365) return `${Math.round(days / 30)} months`;
  return `${Math.round(days / 365)} years`;
}
