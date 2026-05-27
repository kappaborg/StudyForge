'use client';

import { apiGet } from './dev-fetch';

export interface ChunkNeighbor {
  chunkId: string;
  ordinal: number;
  page: number | null;
  content: string;
}

export interface ChunkDetail {
  chunkId: string;
  ordinal: number;
  page: number | null;
  slide: number | null;
  cell: number | null;
  charStart: number;
  charEnd: number;
  content: string;
  documentId: string;
  documentFilename: string;
  documentMime: string;
  versionId: string;
  meta: Record<string, unknown> | null;
  neighbors: { prev: ChunkNeighbor | null; next: ChunkNeighbor | null };
}

export async function fetchChunk(id: string): Promise<ChunkDetail> {
  return apiGet<ChunkDetail>(`/v1/chunks/${id}`);
}
