/**
 * Hand-rolled Meilisearch client. We avoid the official ``meilisearch``
 * npm package because its ESM entry trips Nest's CommonJS module
 * resolution. The surface we need is tiny: ensure-index, set-filterable,
 * add-documents, delete-by-filter, search.
 */

const HOST = process.env['MEILI_HOST'] ?? 'http://localhost:7700';
const KEY = process.env['MEILI_KEY'] ?? 'studyforge-meili-master';

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${HOST}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${KEY}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 400);
    throw new Error(`meili ${res.status} ${path}: ${detail}`);
  }
  // 202 Accepted (async tasks) returns JSON without body shape we care about.
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export async function ensureIndex(uid: string, primaryKey = 'id'): Promise<void> {
  try {
    await call(`/indexes`, {
      method: 'POST',
      body: JSON.stringify({ uid, primaryKey }),
    });
  } catch (err) {
    // Index already exists — Meili returns 409. Treat as ok.
    if (!String(err).includes('409')) throw err;
  }
}

export async function setFilterable(uid: string, attrs: string[]): Promise<void> {
  await call(`/indexes/${uid}/settings/filterable-attributes`, {
    method: 'PUT',
    body: JSON.stringify(attrs),
  });
}

export async function addDocuments(uid: string, docs: object[]): Promise<void> {
  if (docs.length === 0) return;
  await call(`/indexes/${uid}/documents`, {
    method: 'POST',
    body: JSON.stringify(docs),
  });
}

export async function deleteByFilter(uid: string, filter: string): Promise<void> {
  await call(`/indexes/${uid}/documents/delete`, {
    method: 'POST',
    body: JSON.stringify({ filter }),
  });
}

export interface MeiliSearchResult<T> {
  hits: T[];
  query: string;
  processingTimeMs: number;
  estimatedTotalHits?: number;
}

export async function searchIndex<T>(
  uid: string,
  query: string,
  opts: { filter?: string; limit?: number } = {},
): Promise<MeiliSearchResult<T>> {
  return call<MeiliSearchResult<T>>(`/indexes/${uid}/search`, {
    method: 'POST',
    body: JSON.stringify({
      q: query,
      filter: opts.filter,
      limit: opts.limit ?? 10,
    }),
  });
}
