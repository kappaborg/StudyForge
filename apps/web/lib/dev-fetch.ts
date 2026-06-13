/**
 * Dev-mode fetch wrapper. Phase-1: header-based dev auth. Real OAuth replaces
 * this in Phase 1 mid; swap out the headers + add silent refresh and the rest
 * of the codebase keeps working.
 */

// In production we route every API call through Vercel's edge
// rewrites (configured in next.config.mjs) so the request is
// same-origin from the browser's point of view. That makes the
// session cookie first-party on the Vercel domain — works in
// Safari ITP, Chrome's third-party cookie blocker, and Firefox
// without further fuss.
//
// Empty string makes the templated URL ``${API_BASE}/v1/...``
// resolve to ``/v1/...`` (relative to the current origin).
//
// Local dev keeps the explicit ``http://localhost:3001`` so it
// still works without standing up a proxy.
export const API_BASE =
  process.env['NEXT_PUBLIC_AUTH_MODE'] === 'production'
    ? ''
    : (process.env['NEXT_PUBLIC_API_BASE_URL'] ?? 'http://localhost:3001');

export const DEV_TENANT_ID = '11111111-1111-1111-1111-111111111111';
export const DEV_USER_ID = '22222222-2222-2222-2222-222222222222';
export const DEV_USER_EMAIL = 'dev@studyforge.local';

function newIdempotencyKey(): string {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return (
    'key_' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  );
}

interface ProblemDetails {
  type?: string;
  title?: string;
  detail?: string;
  status?: number;
  code?: string;
}

export class ApiError extends Error {
  constructor(public readonly problem: ProblemDetails) {
    super(problem.title ?? `HTTP ${problem.status ?? 0}`);
    this.name = 'ApiError';
  }
}

function devHeaders(): Record<string, string> {
  return {
    'x-tenant-id': DEV_TENANT_ID,
    'x-user-id': DEV_USER_ID,
    'x-user-email': DEV_USER_EMAIL,
  };
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { ...devHeaders(), accept: 'application/json' },
    credentials: 'include',
  });
  return parse<T>(res);
}

/**
 * Cached GET. Read-through localStorage so reloads while offline still
 * show the last-good payload. Used by learning artifacts (decks +
 * roadmaps) that survive without a live network.
 */
export async function apiGetCached<T>(path: string): Promise<T> {
  const key = `sf-cache:${path}`;
  try {
    const fresh = await apiGet<T>(path);
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.setItem(
          key,
          JSON.stringify({ value: fresh, ts: Date.now() }),
        );
      } catch {
        // Quota exceeded etc. — non-fatal.
      }
    }
    return fresh;
  } catch (err) {
    if (typeof window === 'undefined') throw err;
    const raw = window.localStorage.getItem(key);
    if (!raw) throw err;
    try {
      const parsed = JSON.parse(raw) as { value: T };
      return parsed.value;
    } catch {
      throw err;
    }
  }
}

export interface CachedGetResult<T> {
  value: T;
  /** ``true`` when the network call failed and the value came from the
   *  localStorage cache instead. */
  fromCache: boolean;
  /** Epoch ms of the cache write that served this read. ``null`` when
   *  the fresh path returned (caller doesn't need a cache age then). */
  cachedAt: number | null;
}

/**
 * Variant of ``apiGetCached`` that returns metadata about the cache
 * state alongside the value. Lets the UI render a "you're viewing
 * cached content from N min ago" banner without forcing every existing
 * caller to refactor.
 *
 * Network reachable → ``{ value: fresh, fromCache: false, cachedAt: null }``
 * Network unreachable → returns the cached value with ``fromCache: true``
 *   and the ``cachedAt`` timestamp from the original cache write.
 * No cache + no network → rebubbles the underlying error so the UI can
 *   show its own empty / offline state.
 */
export async function apiGetCachedWithMeta<T>(path: string): Promise<CachedGetResult<T>> {
  const key = `sf-cache:${path}`;
  try {
    const fresh = await apiGet<T>(path);
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.setItem(
          key,
          JSON.stringify({ value: fresh, ts: Date.now() }),
        );
      } catch {
        // Quota exceeded etc. — non-fatal.
      }
    }
    return { value: fresh, fromCache: false, cachedAt: null };
  } catch (err) {
    if (typeof window === 'undefined') throw err;
    const raw = window.localStorage.getItem(key);
    if (!raw) throw err;
    try {
      const parsed = JSON.parse(raw) as { value: T; ts?: number };
      return {
        value: parsed.value,
        fromCache: true,
        cachedAt: typeof parsed.ts === 'number' ? parsed.ts : null,
      };
    } catch {
      throw err;
    }
  }
}

export async function apiPost<T>(
  path: string,
  body: object,
  { idempotent = true }: { idempotent?: boolean } = {},
): Promise<T> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
    ...devHeaders(),
  };
  if (idempotent) headers['idempotency-key'] = newIdempotencyKey();
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    credentials: 'include',
  });
  return parse<T>(res);
}

async function parse<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  if (!res.ok) {
    let problem: ProblemDetails = { status: res.status };
    try {
      problem = (await res.json()) as ProblemDetails;
    } catch {
      // not JSON; keep status only
    }
    throw new ApiError(problem);
  }
  return (await res.json()) as T;
}
