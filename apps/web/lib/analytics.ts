/**
 * Typed analytics surface. Wraps PostHog so consumers depend on a stable
 * event-name + props enum rather than the raw SDK. When the public key
 * is missing the module no-ops — safe to ship in dev or to OSS clones
 * that haven't provisioned PostHog yet.
 */

'use client';

import posthog from 'posthog-js';

const KEY = process.env['NEXT_PUBLIC_POSTHOG_KEY'];
const HOST = process.env['NEXT_PUBLIC_POSTHOG_HOST'] ?? 'https://us.i.posthog.com';

let initialized = false;
let enabled = false;

function ensureInit(): void {
  if (initialized || typeof window === 'undefined') return;
  initialized = true;
  if (!KEY) return;
  posthog.init(KEY, {
    api_host: HOST,
    capture_pageview: true,
    autocapture: false,
    persistence: 'localStorage',
  });
  enabled = true;
}

// ── Typed event surface ──────────────────────────────────────────────────────

export type EventName =
  | 'upload.started'
  | 'upload.completed'
  | 'tutor.asked'
  | 'flashcards.generated'
  | 'flashcards.flipped'
  | 'quizzes.generated'
  | 'quizzes.submitted'
  | 'roadmap.generated'
  | 'concepts.extracted'
  | 'diagram.generated'
  | 'search.queried';

export interface EventPropsMap {
  'upload.started': { mime: string; sizeBytes: number };
  'upload.completed': { documentId: string; chunkCount: number; durationMs: number };
  'tutor.asked': { courseId: string | null; retrievedChunks: number; refusal: boolean };
  'flashcards.generated': { courseId: string; deckSize: number; deckId: string };
  'flashcards.flipped': { deckId: string; flashcardId: string };
  'quizzes.generated': { courseId: string; itemCount: number; quizId: string };
  'quizzes.submitted': { quizId: string; score: number; items: number };
  'roadmap.generated': { courseId: string; weeks: number; roadmapId: string };
  'concepts.extracted': { courseId: string; conceptCount: number; edgeCount: number };
  'diagram.generated': { courseId: string; kind: string };
  'search.queried': { query: string; hits: number };
}

export function track<E extends EventName>(name: E, props: EventPropsMap[E]): void {
  ensureInit();
  if (!enabled) return;
  posthog.capture(name, props as Record<string, unknown>);
}

export function identify(userId: string, props?: Record<string, unknown>): void {
  ensureInit();
  if (!enabled) return;
  posthog.identify(userId, props);
}

export const analyticsEnabled = (): boolean => {
  ensureInit();
  return enabled;
};
