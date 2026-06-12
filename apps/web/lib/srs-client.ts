'use client';

import { API_BASE, DEV_TENANT_ID, DEV_USER_EMAIL, DEV_USER_ID, apiGet } from './dev-fetch';
import {
  cacheDue,
  countQueuedGrades,
  enqueueGrade,
  listQueuedGrades,
  readCachedDue,
  recordGradeReplayFailure,
  removeQueuedGrade,
  type QueuedGrade,
} from './offline-review-db';

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

export interface DueCardsResult {
  cards: ReviewableCard[];
  /** ``true`` when served from the offline IDB cache. */
  fromCache: boolean;
  /** Epoch ms — set when ``fromCache`` is true so the UI can show
   *  "viewing N-min-old cache". */
  cachedAt: number | null;
}

/**
 * Fetches the due queue with offline fallback.
 *
 * Online path: network → IDB cache write (so a subsequent offline visit
 *   has fresh data) → return.
 * Offline path: any thrown fetch error falls back to the IDB cache. If
 *   the cache is empty, the original error rebubbles so the UI can show
 *   an "offline & no cache yet" empty state.
 */
export async function fetchDueCards(limit = 20): Promise<DueCardsResult> {
  try {
    const res = await apiGet<{ cards: ReviewableCard[] }>(
      `/v1/flashcards/due?limit=${limit}`,
    );
    // Fire-and-forget the cache write — review shouldn't block on it.
    void cacheDue(limit, res.cards);
    return { cards: res.cards, fromCache: false, cachedAt: null };
  } catch (err) {
    const cached = await readCachedDue<ReviewableCard[]>(limit);
    if (cached) {
      return { cards: cached.cards, fromCache: true, cachedAt: cached.cachedAt };
    }
    throw err;
  }
}

export async function fetchReviewStats(): Promise<ReviewStats> {
  return apiGet<ReviewStats>('/v1/flashcards/review-stats');
}

export interface GradeOutcome {
  /** Server-confirmed schedule update. ``null`` when the grade was
   *  queued for later sync (offline path). */
  result: ReviewResult | null;
  /** ``true`` when the grade was queued in IDB rather than sent
   *  immediately. The UI uses this to label "will sync when online". */
  queued: boolean;
}

/**
 * Submits a grade with offline fallback.
 *
 * If the network is reachable we POST as before and return the
 * server's schedule update. If the POST throws — typically a thrown
 * ``TypeError: Failed to fetch`` from an offline tab — we persist the
 * grade to IDB so it can be replayed by ``flushQueuedGrades`` once
 * connectivity returns. The student's review session continues
 * uninterrupted; nothing is lost.
 */
export async function gradeCard(
  cardId: string,
  quality: number,
): Promise<GradeOutcome> {
  try {
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
      // Server returned a real error response (4xx/5xx). These are NOT
      // offline failures — bubble so the UI can show what went wrong;
      // we don't want to silently queue rejected grades.
      const text = (await res.text()).slice(0, 200);
      throw new Error(text || `HTTP ${res.status}`);
    }
    return { result: (await res.json()) as ReviewResult, queued: false };
  } catch (err) {
    if (isLikelyOfflineError(err)) {
      await enqueueGrade({ cardId, quality });
      return { result: null, queued: true };
    }
    throw err;
  }
}

/**
 * Drains the IDB grade queue against the live API. Returns a summary
 * the UI uses to log "synced N reviews while you were offline." Per-
 * row failures don't abort the drain — each row's retries counter is
 * bumped so a permanently-broken grade doesn't block the rest.
 */
export interface FlushOutcome {
  attempted: number;
  succeeded: number;
  failed: number;
}

export async function flushQueuedGrades(): Promise<FlushOutcome> {
  const queue = await listQueuedGrades();
  let succeeded = 0;
  let failed = 0;
  for (const row of queue) {
    const ok = await replayGrade(row);
    if (ok) {
      succeeded += 1;
      await removeQueuedGrade(row.id);
    } else {
      failed += 1;
    }
  }
  return { attempted: queue.length, succeeded, failed };
}

export async function pendingGradeCount(): Promise<number> {
  return countQueuedGrades();
}

async function replayGrade(row: QueuedGrade): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/v1/flashcards/${row.cardId}/review`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-tenant-id': DEV_TENANT_ID,
        'x-user-id': DEV_USER_ID,
        'x-user-email': DEV_USER_EMAIL,
      },
      body: JSON.stringify({ quality: row.quality }),
      credentials: 'include',
    });
    if (!res.ok) {
      const text = (await res.text()).slice(0, 80);
      await recordGradeReplayFailure(row.id, text || `HTTP ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await recordGradeReplayFailure(row.id, msg);
    return false;
  }
}

function isLikelyOfflineError(err: unknown): boolean {
  // The browser ``fetch`` API throws a ``TypeError`` with a name of
  // "TypeError" and message containing "Failed to fetch" / "NetworkError"
  // when the tab is offline. Also honour the navigator hint when present.
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return true;
  }
  if (err instanceof TypeError) return true;
  return false;
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
