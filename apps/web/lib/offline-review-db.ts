/**
 * IndexedDB layer for offline flashcard review (Phase 3 §10).
 *
 * Two stores:
 *   * ``dueCache``  — the most recent /v1/flashcards/due response, keyed
 *     by ``cacheKey: "due:<limit>"``. Read by the offline path when the
 *     network is unreachable.
 *   * ``gradeQueue`` — pending POST /v1/flashcards/:id/review actions
 *     captured while offline. Each row carries the cardId, quality, a
 *     monotonic ``enqueuedAt`` ts for FIFO replay, and a ``retries``
 *     counter so we can stop hammering after a few failed attempts when
 *     back online.
 *
 * The wrapper is intentionally a tiny ``idb`` adapter — no Dexie, no
 * MobX. Browser-only; never imported from server components.
 */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

const DB_NAME = 'studyforge-offline-review';
const DB_VERSION = 1;

const DUE_CACHE_STORE = 'dueCache';
const GRADE_QUEUE_STORE = 'gradeQueue';

export interface CachedDueRow {
  cacheKey: string;
  cards: unknown;
  cachedAt: number;
}

export interface QueuedGrade {
  /** Locally-generated UUID — the row's primary key in IDB. */
  id: string;
  cardId: string;
  quality: number;
  enqueuedAt: number;
  retries: number;
  /** Last error label — null until a replay attempt has failed. */
  lastError: string | null;
}

interface OfflineReviewSchema extends DBSchema {
  [DUE_CACHE_STORE]: {
    key: string;
    value: CachedDueRow;
  };
  [GRADE_QUEUE_STORE]: {
    key: string;
    value: QueuedGrade;
    indexes: { enqueuedAt: number };
  };
}

let _dbPromise: Promise<IDBPDatabase<OfflineReviewSchema>> | null = null;

function db(): Promise<IDBPDatabase<OfflineReviewSchema>> {
  // Lazy + memoised so SSR import never opens IDB on the server and a
  // single tab reuses one connection.
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB is not available in this context'));
  }
  if (_dbPromise) return _dbPromise;
  _dbPromise = openDB<OfflineReviewSchema>(DB_NAME, DB_VERSION, {
    upgrade(database) {
      if (!database.objectStoreNames.contains(DUE_CACHE_STORE)) {
        database.createObjectStore(DUE_CACHE_STORE, { keyPath: 'cacheKey' });
      }
      if (!database.objectStoreNames.contains(GRADE_QUEUE_STORE)) {
        const store = database.createObjectStore(GRADE_QUEUE_STORE, {
          keyPath: 'id',
        });
        store.createIndex('enqueuedAt', 'enqueuedAt');
      }
    },
  });
  return _dbPromise;
}

// ─────────────────────────────────────────────────────────────────────────────
// Due-card cache
// ─────────────────────────────────────────────────────────────────────────────

export async function cacheDue<T>(limit: number, cards: T): Promise<void> {
  const handle = await db();
  await handle.put(DUE_CACHE_STORE, {
    cacheKey: `due:${limit}`,
    cards,
    cachedAt: Date.now(),
  });
}

export async function readCachedDue<T>(limit: number): Promise<{
  cards: T;
  cachedAt: number;
} | null> {
  try {
    const handle = await db();
    const row = await handle.get(DUE_CACHE_STORE, `due:${limit}`);
    if (!row) return null;
    return { cards: row.cards as T, cachedAt: row.cachedAt };
  } catch {
    // IDB unavailable (private browsing, corrupted store) — degrade
    // gracefully; the caller will surface the no-network error.
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Grade queue
// ─────────────────────────────────────────────────────────────────────────────

function uuid(): string {
  // crypto.randomUUID is in every modern browser we target; the typed
  // narrowing guard keeps TS happy without bringing in a polyfill.
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  // Deterministic fallback for very old contexts. ``Math.random`` is
  // not crypto-grade but for a queue id it doesn't need to be.
  return `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function enqueueGrade(input: {
  cardId: string;
  quality: number;
}): Promise<QueuedGrade> {
  const row: QueuedGrade = {
    id: uuid(),
    cardId: input.cardId,
    quality: input.quality,
    enqueuedAt: Date.now(),
    retries: 0,
    lastError: null,
  };
  const handle = await db();
  await handle.put(GRADE_QUEUE_STORE, row);
  return row;
}

export async function listQueuedGrades(): Promise<QueuedGrade[]> {
  try {
    const handle = await db();
    return handle.getAllFromIndex(GRADE_QUEUE_STORE, 'enqueuedAt');
  } catch {
    return [];
  }
}

export async function countQueuedGrades(): Promise<number> {
  try {
    const handle = await db();
    return handle.count(GRADE_QUEUE_STORE);
  } catch {
    return 0;
  }
}

export async function removeQueuedGrade(id: string): Promise<void> {
  const handle = await db();
  await handle.delete(GRADE_QUEUE_STORE, id);
}

export async function recordGradeReplayFailure(
  id: string,
  reason: string,
): Promise<void> {
  const handle = await db();
  const row = await handle.get(GRADE_QUEUE_STORE, id);
  if (!row) return;
  row.retries += 1;
  row.lastError = reason.slice(0, 240);
  await handle.put(GRADE_QUEUE_STORE, row);
}
