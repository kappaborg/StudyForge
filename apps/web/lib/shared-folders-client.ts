'use client';

import { API_BASE, ApiError, apiGet, apiPost } from './dev-fetch';

export interface SharedFolderRow {
  id: string;
  folderId: string;
  folderName: string;
  code: string;
  title: string;
  createdAt: string;
}

export interface SubscriptionRow {
  id: string;
  sharedFolderId: string;
  folderId: string;
  title: string;
  publishedBy: string;
  documentCount: number;
  subscribedAt: string;
}

function devHeaders(): Record<string, string> {
  return {
    'x-tenant-id': '11111111-1111-1111-1111-111111111111',
    'x-user-id': '22222222-2222-2222-2222-222222222222',
    'x-user-email': 'dev@studyforge.local',
  };
}

export async function getShareForFolder(folderId: string): Promise<SharedFolderRow | null> {
  return apiGet<SharedFolderRow | null>(`/v1/folders/${folderId}/share`);
}

export async function publishFolder(
  folderId: string,
  title?: string,
): Promise<SharedFolderRow> {
  return apiPost<SharedFolderRow>(`/v1/folders/${folderId}/share`, title ? { title } : {});
}

export async function unpublishFolder(folderId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/v1/folders/${folderId}/share`, {
    method: 'DELETE',
    headers: devHeaders(),
    credentials: 'include',
  });
  if (!res.ok && res.status !== 204) {
    throw new ApiError({ status: res.status, title: 'Unpublish failed' });
  }
}

export async function subscribeByCode(code: string): Promise<SubscriptionRow> {
  return apiPost<SubscriptionRow>('/v1/shared/subscribe', { code });
}

export async function listSubscriptions(): Promise<SubscriptionRow[]> {
  const res = await apiGet<{ subscriptions: SubscriptionRow[] }>('/v1/shared/subscriptions');
  return res.subscriptions;
}

export async function unsubscribe(subscriptionId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/v1/shared/subscriptions/${subscriptionId}`, {
    method: 'DELETE',
    headers: devHeaders(),
    credentials: 'include',
  });
  if (!res.ok && res.status !== 204) {
    throw new ApiError({ status: res.status, title: 'Unsubscribe failed' });
  }
}
