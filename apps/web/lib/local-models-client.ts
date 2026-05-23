'use client';

import { API_BASE, ApiError, apiGet, apiPost } from './dev-fetch';

export interface LocalModelRow {
  id: string;
  folderId: string;
  folderName: string;
  status: 'building' | 'ready' | 'failed';
  stale: boolean;
  chunkCount: number;
  sizeBytes: number;
  embedderId: string | null;
  embedderDim: number | null;
  builtAt: string | null;
  createdAt: string;
}

export interface ChunkBundleEntry {
  chunkId: string;
  docId: string;
  filename: string;
  page: number | null;
  content: string;
}

export async function listLocalModels(): Promise<LocalModelRow[]> {
  const res = await apiGet<{ models: LocalModelRow[] }>('/v1/local-models');
  return res.models;
}

export async function createLocalModel(folderId: string): Promise<LocalModelRow> {
  return apiPost<LocalModelRow>('/v1/local-models', { folderId });
}

export async function fetchChunks(modelId: string): Promise<ChunkBundleEntry[]> {
  const res = await apiGet<{ chunks: ChunkBundleEntry[] }>(
    `/v1/local-models/${modelId}/chunks`,
  );
  return res.chunks;
}

export async function markBuilt(
  modelId: string,
  stats: {
    chunkCount: number;
    sizeBytes: number;
    embedderId: string;
    embedderDim: number;
  },
): Promise<LocalModelRow> {
  return apiPost<LocalModelRow>(`/v1/local-models/${modelId}/mark-built`, stats);
}

export async function markFailed(modelId: string): Promise<LocalModelRow> {
  return apiPost<LocalModelRow>(`/v1/local-models/${modelId}/mark-failed`, {});
}

export async function deleteLocalModel(modelId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/v1/local-models/${modelId}`, {
    method: 'DELETE',
    headers: {
      'x-tenant-id': '11111111-1111-1111-1111-111111111111',
      'x-user-id': '22222222-2222-2222-2222-222222222222',
      'x-user-email': 'dev@studyforge.local',
    },
    credentials: 'include',
  });
  if (!res.ok && res.status !== 204) {
    throw new ApiError({ status: res.status, title: 'Delete failed' });
  }
}
