/**
 * Opaque cursor pagination. Clients never decode the cursor — its shape is an
 * implementation detail and may change. Encoded value is base64url(JSON).
 */

export interface CursorPayload {
  /** ISO 8601 timestamp of the boundary row. */
  t: string;
  /** Tiebreaker id for stable ordering across concurrent inserts. */
  id: string;
}

export interface Page<T> {
  data: T[];
  page: {
    nextCursor: string | null;
    prevCursor: string | null;
    limit: number;
  };
}

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;

export function clampLimit(input: unknown): number {
  const n = typeof input === 'string' ? Number.parseInt(input, 10) : Number(input);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.floor(n));
}

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | undefined | null): CursorPayload | null {
  if (!cursor) return null;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed = JSON.parse(decoded) as Partial<CursorPayload>;
    if (typeof parsed.t !== 'string' || typeof parsed.id !== 'string') return null;
    return { t: parsed.t, id: parsed.id };
  } catch {
    return null;
  }
}

/**
 * Builds a Page<T> envelope from a fetched-with-overflow array. Pass `limit + 1`
 * rows to the query; this helper trims and emits the next cursor.
 */
export function buildPage<T extends { id: string; createdAt: Date }>(
  rows: T[],
  limit: number,
  cursor?: CursorPayload | null,
): Page<T> {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const last = data[data.length - 1];
  const nextCursor =
    hasMore && last !== undefined
      ? encodeCursor({ t: last.createdAt.toISOString(), id: last.id })
      : null;
  return {
    data,
    page: {
      nextCursor,
      prevCursor: cursor ? encodeCursor(cursor) : null,
      limit,
    },
  };
}
