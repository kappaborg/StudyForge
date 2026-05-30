/**
 * Single chokepoint for every outbound HTTPS call from the web app.
 *
 *   - Attaches Authorization: Bearer <access token>
 *   - Generates Idempotency-Key for state-changing methods
 *   - Surfaces application/problem+json as a typed `ApiError`
 *   - Silent-refreshes once on 401, dedupes concurrent refreshes
 *   - Propagates W3C `traceparent` so server traces tie to FE timing
 *
 * Components never call fetch directly.
 */

import {
  clearAccessToken,
  getAccessToken,
  isExpired,
  setAccessToken,
} from './auth-store';

// Mirrors lib/dev-fetch.ts — empty in production so calls flow through
// Vercel's same-origin rewrite and the session cookie travels with them.
// Cross-site direct calls to the Render URL would 401 because the cookie
// is on the Vercel domain.
const API_BASE =
  process.env['NEXT_PUBLIC_AUTH_MODE'] === 'production'
    ? ''
    : (process.env['NEXT_PUBLIC_API_BASE_URL'] ?? 'http://localhost:3001');

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  code: string;
  traceId?: string;
  tenantId?: string | null;
  fields?: Array<{ name: string; reason: string }>;
}

export class ApiError extends Error {
  constructor(public readonly problem: ProblemDetails) {
    super(`${problem.code}: ${problem.title}`);
    this.name = 'ApiError';
  }

  get status(): number {
    return this.problem.status;
  }
}

export interface ApiRequest {
  path: string;
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** Caller-provided idempotency key. Defaults to a fresh ULID-like value. */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export async function api<T>(req: ApiRequest): Promise<T> {
  const method = (req.method ?? 'GET').toUpperCase();
  const url = `${API_BASE}${req.path}`;

  const headers: Record<string, string> = {
    accept: 'application/json',
    ...req.headers,
  };
  if (req.body !== undefined && headers['content-type'] === undefined) {
    headers['content-type'] = 'application/json';
  }
  if (STATE_CHANGING.has(method) && headers['idempotency-key'] === undefined) {
    headers['idempotency-key'] = req.idempotencyKey ?? generateIdempotencyKey();
  }

  const traceId = newTraceId();
  headers['traceparent'] = `00-${traceId}-${randomHex(16)}-01`;

  await ensureFreshToken();
  attachAuth(headers);

  const init: RequestInit = {
    method,
    headers,
    credentials: 'include',
    body: req.body === undefined ? null : JSON.stringify(req.body),
  };
  if (req.signal !== undefined) init.signal = req.signal;

  let response = await fetch(url, init);
  if (response.status === 401) {
    const refreshed = await refreshOnce();
    if (refreshed) {
      attachAuth(headers);
      response = await fetch(url, init);
    }
  }

  if (response.status === 204) {
    return undefined as T;
  }
  if (!response.ok) {
    throw await readProblem(response);
  }
  return (await response.json()) as T;
}

// ─────────────────────────────────────────────────────────────────────────────
// Refresh — single-flight via a shared promise
// ─────────────────────────────────────────────────────────────────────────────

let refreshInFlight: Promise<boolean> | null = null;

async function refreshOnce(): Promise<boolean> {
  if (refreshInFlight !== null) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const res = await fetch(`${API_BASE}/v1/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) {
        clearAccessToken();
        return false;
      }
      const body = (await res.json()) as { accessToken: string; expiresIn: number };
      setAccessToken(body.accessToken, body.expiresIn);
      return true;
    } catch {
      clearAccessToken();
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

async function ensureFreshToken(): Promise<void> {
  if (getAccessToken() === null) return;
  if (isExpired()) {
    await refreshOnce();
  }
}

function attachAuth(headers: Record<string, string>): void {
  const token = getAccessToken();
  if (token !== null) {
    headers['authorization'] = `Bearer ${token}`;
  } else {
    delete headers['authorization'];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Problem+JSON parser
// ─────────────────────────────────────────────────────────────────────────────

async function readProblem(res: Response): Promise<ApiError> {
  try {
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('problem+json') || ct.includes('application/json')) {
      const problem = (await res.json()) as ProblemDetails;
      return new ApiError(problem);
    }
  } catch {
    // fall through
  }
  return new ApiError({
    type: 'https://studyforge.ai/errors/transport',
    title: `Transport error (${res.status})`,
    status: res.status,
    code: 'transport',
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Idempotency-Key + traceparent helpers
// ─────────────────────────────────────────────────────────────────────────────

function generateIdempotencyKey(): string {
  // ULID-style: 26 chars of Crockford base32. The interceptor only requires
  // [A-Za-z0-9_-]{16,64}.
  return `key_${randomHex(20)}`;
}

function newTraceId(): string {
  return randomHex(16);
}

function randomHex(byteCount: number): string {
  const arr = new Uint8Array(byteCount);
  if (typeof crypto !== 'undefined' && 'getRandomValues' in crypto) {
    crypto.getRandomValues(arr);
  } else {
    for (let i = 0; i < byteCount; i++) arr[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}
