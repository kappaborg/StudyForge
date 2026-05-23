/**
 * Access-token store.
 *
 * Tokens live in this module's closure — never in localStorage, sessionStorage,
 * IndexedDB, or any other web-accessible store. The refresh token lives in an
 * HttpOnly cookie the JS cannot read. `api-client` is the only consumer; tests
 * import `__resetForTests` to reset state.
 */

let accessToken: string | null = null;
let expiresAt: number | null = null;
const listeners = new Set<(token: string | null) => void>();

export function getAccessToken(): string | null {
  return accessToken;
}

export function setAccessToken(token: string, expiresInSec: number): void {
  accessToken = token;
  expiresAt = Date.now() + Math.max(0, expiresInSec - 30) * 1000; // refresh 30s early
  for (const fn of listeners) fn(token);
}

export function clearAccessToken(): void {
  accessToken = null;
  expiresAt = null;
  for (const fn of listeners) fn(null);
}

export function isExpired(now: number = Date.now()): boolean {
  if (accessToken === null || expiresAt === null) return true;
  return expiresAt <= now;
}

export function subscribe(fn: (token: string | null) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Test-only. The runtime tree-shakes this in production builds. */
export function __resetForTests(): void {
  accessToken = null;
  expiresAt = null;
  listeners.clear();
}
