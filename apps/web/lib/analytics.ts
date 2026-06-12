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

/**
 * Event catalogue — every name here is something we actually look at.
 * Adding an event without a story for what dashboard / question it
 * answers means it should not ship. Dropping an event is also fine and
 * encouraged; ``flashcards.flipped`` was retired in the streaks pass
 * because SRS review events tell us the same thing with less noise.
 *
 * Naming convention: ``noun.past_verb`` (snake_case noun, dotted, past
 * tense). Keeps events explicit ("the user did X") instead of slipping
 * into "tracking-as-logging" territory.
 *
 * Property hygiene:
 *   • Never include free-form user text (query strings, document
 *     content, message bodies) — only IDs, counts, sizes.
 *   • Counts and durations are numbers, not strings.
 *   • IDs always uuid-strings; never the underlying URL or filename.
 */
export type EventName =
  // Funnel
  | 'signup.completed'
  // Materials
  | 'upload.started'
  | 'upload.completed'
  | 'youtube.ingested'
  | 'text.ingested'
  | 'multipart.part_failed'
  // Active learning
  | 'tutor.asked'
  | 'srs.reviewed'
  | 'flashcards.generated'
  | 'quizzes.generated'
  | 'quizzes.submitted'
  | 'roadmap.generated'
  | 'concepts.extracted'
  | 'diagram.generated'
  // Scopes
  | 'scope.created'
  | 'scope.forked'
  // Sharing
  | 'folder.published'
  | 'folder.subscribed'
  // Misc
  | 'search.queried';

export interface EventPropsMap {
  'signup.completed': { userId: string };
  'upload.started': { mime: string; sizeBytes: number; multipart: boolean };
  'upload.completed': { documentId: string; chunkCount: number; durationMs: number; multipart: boolean };
  'youtube.ingested': { documentId: string; chunkCount: number };
  'text.ingested': { documentId: string; chunkCount: number; source: 'extension' | 'web' };
  'multipart.part_failed': { partNumber: number; partCount: number; sizeBytes: number };
  'tutor.asked': { courseId: string | null; retrievedChunks: number; refusal: boolean };
  'srs.reviewed': {
    flashcardId: string;
    quality: number;
    /** Server-confirmed next interval, or -1 when the grade was
     *  queued offline and will sync later. */
    intervalDays: number;
    queued?: boolean;
  };
  'flashcards.generated': { courseId: string; deckSize: number; deckId: string };
  'quizzes.generated': { courseId: string; itemCount: number; quizId: string };
  'quizzes.submitted': { quizId: string; score: number; items: number };
  'roadmap.generated': { courseId: string; weeks: number; roadmapId: string };
  'concepts.extracted': { courseId: string; conceptCount: number; edgeCount: number };
  'diagram.generated': { courseId: string; kind: string };
  'scope.created': { scopeId: string; entryCount: number; hasExamDate: boolean };
  'scope.forked': { scopeId: string };
  'folder.published': { folderId: string };
  'folder.subscribed': { sharedFolderId: string };
  'search.queried': { hits: number };
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
