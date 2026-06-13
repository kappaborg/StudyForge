import { CachedJwksFetcher } from './jwks-fetcher';
import type { Jwk } from './launch';

/**
 * Tests for the keyset cache. The HTTP fetch is mocked so we never
 * leave the process.
 */

function fakeFetchFor(keys: Jwk[]): jest.MockedFunction<typeof fetch> {
  return jest.fn(async () => {
    return new Response(JSON.stringify({ keys }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as jest.MockedFunction<typeof fetch>;
}

const K1: Jwk = { kty: 'RSA', kid: 'k1', n: 'x', e: 'AQAB' };
const K2: Jwk = { kty: 'RSA', kid: 'k2', n: 'y', e: 'AQAB' };

describe('CachedJwksFetcher', () => {
  it('fetches and caches a key by kid', async () => {
    const http = fakeFetchFor([K1, K2]);
    const fetcher = new CachedJwksFetcher('https://x/jwks', 60_000, http);
    const hit = await fetcher.fetchKey('k1');
    expect(hit).toEqual(K1);
    expect(http).toHaveBeenCalledTimes(1);
    expect(fetcher.size()).toBe(2);
  });

  it('serves subsequent reads from cache without refetching', async () => {
    const http = fakeFetchFor([K1, K2]);
    const fetcher = new CachedJwksFetcher('https://x/jwks', 60_000, http);
    await fetcher.fetchKey('k1');
    await fetcher.fetchKey('k1');
    await fetcher.fetchKey('k2');
    expect(http).toHaveBeenCalledTimes(1);
  });

  it('returns null and does not re-fetch within TTL for unknown kid', async () => {
    const http = fakeFetchFor([K1]);
    const fetcher = new CachedJwksFetcher('https://x/jwks', 60_000, http);
    await fetcher.fetchKey('k1');
    expect(http).toHaveBeenCalledTimes(1);
    const miss = await fetcher.fetchKey('unknown');
    expect(miss).toBeNull();
    // Still one fetch — the cache has a known key, so a miss within TTL
    // means the platform genuinely doesn't expose this kid.
    expect(http).toHaveBeenCalledTimes(1);
  });

  it('refreshes after TTL expires when looking up a new kid', async () => {
    const http = jest
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ keys: [K1] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ keys: [K1, K2] }))) as jest.MockedFunction<typeof fetch>;
    const fetcher = new CachedJwksFetcher('https://x/jwks', 0, http);
    await fetcher.fetchKey('k1');
    // TTL=0 → second call is past TTL, triggers a refresh on the miss.
    const k2 = await fetcher.fetchKey('k2');
    expect(k2).toEqual(K2);
    expect(http).toHaveBeenCalledTimes(2);
  });

  it('throws when the JWKS endpoint returns a non-2xx status', async () => {
    const http = jest.fn(async () => new Response('boom', { status: 500 })) as jest.MockedFunction<
      typeof fetch
    >;
    const fetcher = new CachedJwksFetcher('https://x/jwks', 60_000, http);
    await expect(fetcher.fetchKey('k1')).rejects.toThrow('jwks fetch failed 500');
  });

  it('throws when the body lacks a keys array', async () => {
    const http = jest.fn(
      async () => new Response(JSON.stringify({}), { status: 200 }),
    ) as jest.MockedFunction<typeof fetch>;
    const fetcher = new CachedJwksFetcher('https://x/jwks', 60_000, http);
    await expect(fetcher.fetchKey('k1')).rejects.toThrow('missing keys array');
  });

  it('shares the in-flight refresh promise across concurrent callers', async () => {
    let resolveFetch: (r: Response) => void = () => {};
    const http = jest.fn(
      () =>
        new Promise<Response>((res) => {
          resolveFetch = res;
        }),
    ) as jest.MockedFunction<typeof fetch>;
    const fetcher = new CachedJwksFetcher('https://x/jwks', 60_000, http);
    const a = fetcher.fetchKey('k1');
    const b = fetcher.fetchKey('k1');
    resolveFetch(new Response(JSON.stringify({ keys: [K1] })));
    await Promise.all([a, b]);
    expect(http).toHaveBeenCalledTimes(1);
  });
});
