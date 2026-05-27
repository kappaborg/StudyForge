'use client';

import { API_BASE, ApiError, apiGet, apiPost } from './dev-fetch';

export type ScopeMode = 'theory' | 'problems';

export interface ScopeEntry {
  mode: ScopeMode;
  chapters: number[];
  topics: string[];
}

export interface ExamScopeRow {
  id: string;
  folderId: string;
  folderName: string;
  title: string;
  examDate: string | null;
  scopes: ScopeEntry[];
  rawText: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ParsedScope {
  title: string;
  scopes: ScopeEntry[];
}

export async function listExamScopes(): Promise<ExamScopeRow[]> {
  const res = await apiGet<{ scopes: ExamScopeRow[] }>('/v1/exam-scopes');
  return res.scopes;
}

export async function getExamScope(id: string): Promise<ExamScopeRow> {
  return apiGet<ExamScopeRow>(`/v1/exam-scopes/${id}`);
}

export async function parseExamScope(text: string): Promise<ParsedScope> {
  return apiPost<ParsedScope>('/v1/exam-scopes/parse', { text });
}

export async function createExamScope(input: {
  folderId: string;
  title: string;
  scopes: ScopeEntry[];
  examDate?: string | null;
  rawText?: string | null;
}): Promise<ExamScopeRow> {
  return apiPost<ExamScopeRow>('/v1/exam-scopes', input);
}

export async function updateExamScope(
  id: string,
  input: { title?: string; scopes?: ScopeEntry[]; examDate?: string | null },
): Promise<ExamScopeRow> {
  const res = await fetch(`${API_BASE}/v1/exam-scopes/${id}`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      'x-tenant-id': '11111111-1111-1111-1111-111111111111',
      'x-user-id': '22222222-2222-2222-2222-222222222222',
      'x-user-email': 'dev@studyforge.local',
    },
    body: JSON.stringify(input),
    credentials: 'include',
  });
  if (!res.ok) {
    let problem;
    try {
      problem = await res.json();
    } catch {
      problem = { status: res.status };
    }
    throw new ApiError(problem);
  }
  return (await res.json()) as ExamScopeRow;
}

export async function deleteExamScope(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/v1/exam-scopes/${id}`, {
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

/** Union of chapter numbers across all scope entries. */
export function chapterUnion(scope: ExamScopeRow): number[] {
  const set = new Set<number>();
  for (const s of scope.scopes) for (const c of s.chapters) set.add(c);
  return Array.from(set).sort((a, b) => a - b);
}

// ── Sharing (study-group fork) ──────────────────────────────────────────────

export interface ScopeShareLink {
  token: string;
  createdAt: string;
}

export interface ScopePreview {
  title: string;
  scopes: ScopeEntry[];
  examDate: string | null;
  sourceFolderName: string;
  sharedBy: string;
}

export async function getScopeShareLink(scopeId: string): Promise<ScopeShareLink | null> {
  return apiGet<ScopeShareLink | null>(`/v1/exam-scopes/${scopeId}/share`);
}

export async function createScopeShareLink(
  scopeId: string,
  opts: { rotate?: boolean } = {},
): Promise<ScopeShareLink> {
  return apiPost<ScopeShareLink>(`/v1/exam-scopes/${scopeId}/share`, opts);
}

export async function revokeScopeShareLink(scopeId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/v1/exam-scopes/${scopeId}/share`, {
    method: 'DELETE',
    headers: {
      'x-tenant-id': '11111111-1111-1111-1111-111111111111',
      'x-user-id': '22222222-2222-2222-2222-222222222222',
      'x-user-email': 'dev@studyforge.local',
    },
    credentials: 'include',
  });
  if (!res.ok && res.status !== 204) {
    throw new ApiError({ status: res.status, title: 'Revoke failed' });
  }
}

export async function previewSharedScope(token: string): Promise<ScopePreview> {
  return apiGet<ScopePreview>(`/v1/shared/scopes/preview/${encodeURIComponent(token)}`);
}

export async function acceptSharedScope(
  token: string,
  folderId: string,
): Promise<ExamScopeRow> {
  return apiPost<ExamScopeRow>('/v1/shared/scopes/accept', { token, folderId });
}
