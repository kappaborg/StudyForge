'use client';

import { useEffect, useState } from 'react';
import { apiGet, apiPost, API_BASE, ApiError, DEV_TENANT_ID, DEV_USER_ID, DEV_USER_EMAIL } from './dev-fetch';

export type FolderKind = 'materials' | 'inbox' | 'trash';

export interface Folder {
  id: string;
  name: string;
  slug: string;
  color: string | null;
  kind: FolderKind;
  documentCount: number;
  deckCount: number;
  quizCount: number;
  createdAt: string;
  updatedAt: string;
}

const STORAGE_KEY = 'sf-last-folder-id';

/**
 * useFolders — fetches the user's folder list with auto-refresh on focus.
 * The returned ``activeFolderId`` is the last-used folder (localStorage),
 * falling back to the Inbox folder when no preference is stored.
 */
export function useFolders() {
  const [folders, setFolders] = useState<Folder[]>([]);
  const [activeFolderId, setActiveFolderId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const res = await apiGet<Folder[]>('/v1/folders');
      setFolders(res);
      setError(null);
      if (!activeFolderId) {
        const stored = typeof window !== 'undefined' ? window.localStorage.getItem(STORAGE_KEY) : null;
        const valid = stored && res.some((f) => f.id === stored) ? stored : null;
        const fallback = res.find((f) => f.kind === 'inbox')?.id ?? res[0]?.id ?? null;
        setActiveFolderId(valid ?? fallback);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load folders');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const select = (id: string) => {
    setActiveFolderId(id);
    try {
      window.localStorage.setItem(STORAGE_KEY, id);
    } catch {
      // localStorage full / disabled — non-fatal.
    }
  };

  const create = async (name: string, color?: string) => {
    const res = await apiPost<Folder>('/v1/folders', { name, ...(color ? { color } : {}) });
    await refresh();
    select(res.id);
    return res;
  };

  const rename = async (id: string, name: string) => {
    const res = await fetch(`${API_BASE}/v1/folders/${id}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'x-tenant-id': DEV_TENANT_ID,
        'x-user-id': DEV_USER_ID,
        'x-user-email': DEV_USER_EMAIL,
      },
      body: JSON.stringify({ name }),
      credentials: 'include',
    });
    if (!res.ok) {
      throw new Error((await res.text()).slice(0, 200) || `HTTP ${res.status}`);
    }
    await refresh();
  };

  const remove = async (id: string) => {
    const res = await fetch(`${API_BASE}/v1/folders/${id}`, {
      method: 'DELETE',
      headers: {
        'x-tenant-id': DEV_TENANT_ID,
        'x-user-id': DEV_USER_ID,
        'x-user-email': DEV_USER_EMAIL,
      },
      credentials: 'include',
    });
    if (!res.ok) {
      throw new Error((await res.text()).slice(0, 200) || `HTTP ${res.status}`);
    }
    await refresh();
  };

  const activeFolder = folders.find((f) => f.id === activeFolderId) ?? null;

  return {
    folders,
    activeFolder,
    activeFolderId,
    setActiveFolderId: select,
    loading,
    error,
    refresh,
    create,
    rename,
    remove,
  };
}
