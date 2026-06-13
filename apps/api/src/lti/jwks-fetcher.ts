import type { Jwk, JwksFetcher } from './launch';

/**
 * HTTP-backed ``JwksFetcher`` with an in-memory keyset cache.
 *
 * One instance per ``jwks_uri``; ``LtiService`` memoises by URI so two
 * tenants pointed at the same Canvas issuer share the keyset (Canvas
 * rotates infrequently and refreshing per tenant would saturate the
 * platform). Cache hits are O(1); misses re-fetch the whole document
 * (the JWKS endpoint usually serves all active keys at once).
 *
 * Behaviour
 *   * ``fetchKey(kid)`` returns the matching JWK or ``null``.
 *   * On a cache miss we refresh once; if the ``kid`` still isn't
 *     present after the refresh, return ``null`` so the validator
 *     surfaces ``key_not_found`` cleanly.
 *   * Refreshes are debounced: concurrent ``fetchKey`` calls during a
 *     fetch share the same in-flight promise.
 */
export class CachedJwksFetcher implements JwksFetcher {
  private cache: Map<string, Jwk> = new Map();
  private lastFetchedAt = 0;
  private fetchInFlight: Promise<void> | null = null;

  constructor(
    private readonly jwksUri: string,
    private readonly ttlMs: number = 60 * 60 * 1000,
    private readonly httpFetch: typeof fetch = fetch,
  ) {}

  async fetchKey(kid: string): Promise<Jwk | null> {
    const cached = this.cache.get(kid);
    if (cached) return cached;

    // Cache miss — refresh if the cache is empty / stale, otherwise
    // accept that the platform really doesn't have this key.
    const now = Date.now();
    if (this.cache.size > 0 && now - this.lastFetchedAt < this.ttlMs) {
      return null;
    }
    await this.refresh();
    return this.cache.get(kid) ?? null;
  }

  /** Force a fetch; tests use this to seed the cache. */
  async refresh(): Promise<void> {
    if (this.fetchInFlight) {
      await this.fetchInFlight;
      return;
    }
    this.fetchInFlight = (async () => {
      try {
        const res = await this.httpFetch(this.jwksUri, {
          headers: { accept: 'application/json' },
        });
        if (!res.ok) {
          throw new Error(
            `jwks fetch failed ${res.status} for ${this.jwksUri}`,
          );
        }
        const body = (await res.json()) as { keys?: unknown };
        if (!body || !Array.isArray(body.keys)) {
          throw new Error(`jwks response missing keys array`);
        }
        const next = new Map<string, Jwk>();
        for (const raw of body.keys) {
          if (!raw || typeof raw !== 'object') continue;
          const jwk = raw as Jwk;
          if (typeof jwk.kid === 'string' && jwk.kid !== '') {
            next.set(jwk.kid, jwk);
          }
        }
        this.cache = next;
        this.lastFetchedAt = Date.now();
      } finally {
        this.fetchInFlight = null;
      }
    })();
    await this.fetchInFlight;
  }

  /** Test-only: peek at the current keyset. */
  size(): number {
    return this.cache.size;
  }
}
