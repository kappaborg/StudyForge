'use client';

import { openDB, type IDBPDatabase } from 'idb';

/**
 * IndexedDB layout for browser-local "offline tutor" indexes.
 *
 *   sf-local-models  (db, schema v2 — userId-namespaced)
 *     ├ meta   keyed (userId, folderId) → { ...index metadata }
 *     └ chunks keyed `${userId}::${folderId}::${chunkId}` → { vector + content }
 *
 * Why namespace by userId?
 *
 * IndexedDB is per-origin, NOT per-user. Without namespacing, if two
 * accounts share the same browser, account A's vectors count toward
 * account B's storage meter and (worse) could be loaded if B knew or
 * guessed a folderId. We key every row by ``userId`` so reads filter on
 * the active account, and we provide ``deleteUserData`` so the sign-out
 * flow wipes the leaving user's bytes.
 *
 * Schema v2 wipes any legacy v1 entries on upgrade — those rows were
 * un-namespaced and would have ambiguous ownership.
 */

const DB_NAME = 'sf-local-models';
const DB_VERSION = 2;
const META_STORE = 'meta';
const CHUNKS_STORE = 'chunks';

export interface LocalIndexMeta {
  userId: string;
  folderId: string;
  modelId: string;
  builtAt: number;
  embedderId: string;
  embedderDim: number;
  chunkCount: number;
  bytesEstimate: number;
}

export interface LocalChunk {
  userId: string;
  folderId: string;
  chunkId: string;
  docId: string;
  filename: string;
  page: number | null;
  content: string;
  vector: Float32Array;
}

interface ChunkRow extends LocalChunk {
  key: string;
}

let _db: Promise<IDBPDatabase> | null = null;

function openDatabase(): Promise<IDBPDatabase> {
  if (_db) return _db;
  _db = openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      // Drop any legacy v1 stores — they were un-namespaced and we have no
      // safe way to attribute their rows to the current user.
      for (const name of [META_STORE, CHUNKS_STORE]) {
        if (db.objectStoreNames.contains(name)) db.deleteObjectStore(name);
      }
      const meta = db.createObjectStore(META_STORE, {
        keyPath: ['userId', 'folderId'],
      });
      meta.createIndex('by-user', 'userId');

      const chunks = db.createObjectStore(CHUNKS_STORE, { keyPath: 'key' });
      chunks.createIndex('by-user-folder', ['userId', 'folderId']);
      chunks.createIndex('by-user', 'userId');
    },
  });
  return _db;
}

function chunkKey(userId: string, folderId: string, chunkId: string): string {
  return `${userId}::${folderId}::${chunkId}`;
}

/**
 * Replace the entire index for a (user, folder) pair. Idempotent — used by
 * both first build and Rebuild flows. Wrapped in a single transaction so a
 * half-built index can't show up if the tab closes mid-write.
 */
export async function saveIndex(
  meta: LocalIndexMeta,
  chunks: Array<Omit<LocalChunk, 'userId' | 'folderId'>>,
): Promise<void> {
  const db = await openDatabase();
  const tx = db.transaction([META_STORE, CHUNKS_STORE], 'readwrite');
  const chunkStore = tx.objectStore(CHUNKS_STORE);
  // Drop any prior chunks for this (userId, folderId).
  const existing = await chunkStore
    .index('by-user-folder')
    .getAllKeys([meta.userId, meta.folderId]);
  for (const key of existing) await chunkStore.delete(key as string);
  for (const c of chunks) {
    const row: ChunkRow = {
      key: chunkKey(meta.userId, meta.folderId, c.chunkId),
      userId: meta.userId,
      folderId: meta.folderId,
      chunkId: c.chunkId,
      docId: c.docId,
      filename: c.filename,
      page: c.page,
      content: c.content,
      vector: c.vector,
    };
    await chunkStore.put(row);
  }
  await tx.objectStore(META_STORE).put(meta);
  await tx.done;
}

export async function loadMeta(
  userId: string,
  folderId: string,
): Promise<LocalIndexMeta | null> {
  const db = await openDatabase();
  const row = (await db.get(META_STORE, [userId, folderId])) as
    | LocalIndexMeta
    | undefined;
  return row ?? null;
}

export async function loadChunks(
  userId: string,
  folderId: string,
): Promise<LocalChunk[]> {
  const db = await openDatabase();
  const rows = (await db.getAllFromIndex(
    CHUNKS_STORE,
    'by-user-folder',
    [userId, folderId],
  )) as ChunkRow[];
  return rows.map((r) => ({
    userId: r.userId,
    folderId: r.folderId,
    chunkId: r.chunkId,
    docId: r.docId,
    filename: r.filename,
    page: r.page,
    content: r.content,
    vector: r.vector,
  }));
}

export async function deleteIndex(
  userId: string,
  folderId: string,
): Promise<void> {
  const db = await openDatabase();
  const tx = db.transaction([META_STORE, CHUNKS_STORE], 'readwrite');
  const chunkStore = tx.objectStore(CHUNKS_STORE);
  const keys = await chunkStore
    .index('by-user-folder')
    .getAllKeys([userId, folderId]);
  for (const key of keys) await chunkStore.delete(key as string);
  await tx.objectStore(META_STORE).delete([userId, folderId]);
  await tx.done;
}

export async function listUserMeta(userId: string): Promise<LocalIndexMeta[]> {
  const db = await openDatabase();
  return (await db.getAllFromIndex(META_STORE, 'by-user', userId)) as LocalIndexMeta[];
}

/**
 * Wipe every row belonging to a user. Called from the sign-out flow so
 * the next account on this browser can't read A's vectors or see them
 * counted in the storage meter.
 */
export async function deleteUserData(userId: string): Promise<void> {
  const db = await openDatabase();
  const tx = db.transaction([META_STORE, CHUNKS_STORE], 'readwrite');
  const chunkStore = tx.objectStore(CHUNKS_STORE);
  const chunkKeys = await chunkStore.index('by-user').getAllKeys(userId);
  for (const key of chunkKeys) await chunkStore.delete(key as string);
  const metaStore = tx.objectStore(META_STORE);
  const metaKeys = await metaStore.index('by-user').getAllKeys(userId);
  for (const key of metaKeys) await metaStore.delete(key as IDBValidKey);
  await tx.done;
}

/**
 * Per-user storage usage in bytes, summed from this user's own meta rows.
 * Replaces ``navigator.storage.estimate()`` for the offline-models meter,
 * which would otherwise include cross-account bytes from prior sessions.
 */
export async function userBytes(userId: string): Promise<number> {
  const metas = await listUserMeta(userId);
  return metas.reduce((sum, m) => sum + (m.bytesEstimate || 0), 0);
}

/** Soft cap surfaced to the UI. 500 MB. */
export const LOCAL_MODEL_CAP_BYTES = 500 * 1024 * 1024;
