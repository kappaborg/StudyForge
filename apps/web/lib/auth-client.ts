/**
 * Client-side auth helpers. Sends credentials with every call so the
 * httpOnly session cookie travels back to the API.
 */

import { API_BASE, ApiError } from './dev-fetch';

export interface Me {
  userId: string;
  tenantId: string;
  email: string;
  role: string;
}

interface ProblemDetails {
  type?: string;
  title?: string;
  detail?: string;
  status?: number;
  code?: string;
}

async function send<T>(
  path: string,
  init: RequestInit & { json?: object } = {},
): Promise<T> {
  const { json, ...rest } = init;
  const headers: Record<string, string> = {
    accept: 'application/json',
    ...(json ? { 'content-type': 'application/json' } : {}),
    ...((rest.headers as Record<string, string>) ?? {}),
  };
  const res = await fetch(`${API_BASE}${path}`, {
    ...rest,
    headers,
    body: json ? JSON.stringify(json) : rest.body,
    credentials: 'include',
  });
  if (res.status === 204) return undefined as T;
  if (!res.ok) {
    let problem: ProblemDetails = { status: res.status };
    try {
      problem = (await res.json()) as ProblemDetails;
    } catch {
      // not JSON
    }
    throw new ApiError(problem);
  }
  return (await res.json()) as T;
}

export const authClient = {
  signup: (email: string, password: string) =>
    send<Me>('/v1/auth/signup', { method: 'POST', json: { email, password } }),
  login: (email: string, password: string) =>
    send<Me>('/v1/auth/login', { method: 'POST', json: { email, password } }),
  logout: () => send<void>('/v1/auth/logout', { method: 'POST' }),
  me: () => send<Me>('/v1/auth/me'),
};

/**
 * Public flag that callers consult to decide whether to gate routes on a
 * signed-in user. Dev mode (header-based) skips the gate.
 */
export const AUTH_REQUIRED =
  (process.env['NEXT_PUBLIC_AUTH_MODE'] ?? 'real') !== 'dev';
