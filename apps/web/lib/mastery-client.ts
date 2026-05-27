'use client';

import { apiGet, apiPost } from './dev-fetch';

export interface MasteryRow {
  conceptId: string;
  label: string;
  mastery: number;
  attempts: number;
  correct: number;
  lastSeenAt: string;
  courseId: string;
  courseTitle: string;
}

export async function fetchMastery(): Promise<MasteryRow[]> {
  const res = await apiGet<{ rows: MasteryRow[] }>('/v1/mastery');
  return res.rows;
}

export async function fetchWeakest(n = 8): Promise<MasteryRow[]> {
  const res = await apiGet<{ rows: MasteryRow[] }>(`/v1/mastery?weakest=${n}`);
  return res.rows;
}

/**
 * Kicks off an adaptive quiz seeded from the user's weakest concepts.
 * Strategy: take the bottom-N concept labels and use them as the quiz
 * generation query. The existing retrieval pipeline then surfaces chunks
 * about those topics; the worker tags resulting items with conceptIds;
 * the next submission updates mastery — closing the loop.
 *
 * Returns the new quiz id so the caller can navigate to /quizzes/[id].
 */
export async function generateAdaptiveQuiz(): Promise<{ quizId: string }> {
  const weakest = await fetchWeakest(8);
  if (weakest.length === 0) {
    throw new Error('No mastery data yet — take a quiz first so we know what to drill.');
  }
  const query = weakest.map((w) => w.label).join(', ');
  const courseId = weakest[0]?.courseId;
  const res = await apiPost<{ quizId: string }>('/v1/quizzes/generate', {
    ...(courseId ? { courseId } : {}),
    query,
    itemCount: Math.min(10, weakest.length + 2),
  });
  return res;
}
