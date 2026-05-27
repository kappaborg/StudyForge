/**
 * Tiny HTTP client. Speaks to the same StudyForge API the web app uses
 * and relies on the same ``sf_session`` cookie — so the extension is
 * authenticated whenever the user has signed in via the website. No
 * per-extension token plumbing; ``credentials: 'include'`` does the work.
 *
 * Two values are baked at build time by build.mjs:
 *   STUDYFORGE_API_URL — gateway base URL
 *   STUDYFORGE_WEB_URL — used for "Sign in" + "Open document" deep links
 */

// Ambient ``process`` shim — esbuild's ``define`` substitutes the
// references at build time with literals from build.mjs. TypeScript
// doesn't see that substitution, so declare it just for the checker.
declare const process: { env: Record<string, string | undefined> };

export const API_URL = process.env['STUDYFORGE_API_URL'] ?? 'http://localhost:3001';
export const WEB_URL = process.env['STUDYFORGE_WEB_URL'] ?? 'http://localhost:3000';

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function http<T>(method: string, path: string, body?: object): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  // The /v1/uploads/text endpoint is gated by the @Idempotent() interceptor.
  // Generate a short random key per call so repeated sends from the same
  // popup session don't collapse into one document.
  if (method !== 'GET') {
    headers['idempotency-key'] = `ext-${Date.now()}-${rand(16)}`;
  }
  const init: RequestInit = {
    method,
    headers,
    credentials: 'include',
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`${API_URL}${path}`, init);
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const json = (await res.json()) as { detail?: string; title?: string };
      detail = json.detail ?? json.title ?? detail;
    } catch {
      try {
        detail = (await res.text()).slice(0, 200) || detail;
      } catch {
        /* ignore */
      }
    }
    throw new ApiError(res.status, detail);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

function rand(n: number): string {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// ── shapes ──────────────────────────────────────────────────────────────────

export interface Me {
  userId: string;
  tenantId: string;
  email: string;
  role: string;
}

export interface FolderRow {
  id: string;
  name: string;
  slug: string;
  kind: 'materials' | 'inbox' | 'trash';
  documentCount: number;
}

export interface TextIngestResult {
  uploadId: string;
  state: string;
  documentId: string;
  chunkCount: number;
  title: string;
}

// ── operations ──────────────────────────────────────────────────────────────

export async function fetchMe(): Promise<Me | null> {
  try {
    return await http<Me>('GET', '/v1/auth/me');
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}

export async function fetchFolders(): Promise<FolderRow[]> {
  // The folders endpoint returns the array directly (legacy quirk —
  // not wrapped in { folders }).
  return http<FolderRow[]>('GET', '/v1/folders');
}

export async function sendText(payload: {
  title: string;
  text: string;
  folderId?: string | null;
  sourceUrl?: string | null;
}): Promise<TextIngestResult> {
  return http<TextIngestResult>('POST', '/v1/uploads/text', payload);
}
