import type { ProviderId } from '@studyforge/shared-types';

/**
 * Per-call cost + quota accounting. Persists to the `UsageEvent` table.
 * Implementation lands in Phase 1 with the LLM router.
 */
export interface UsageEvent {
  id: string;
  tenantId: string;
  userId: string;
  providerId: ProviderId;
  model: string;
  tokensIn: number;
  tokensOut: number;
  cacheHit: boolean;
  costUsd: number;
  /** stable agent id, e.g. 'tutor.answer.v1' */
  agent: string;
  ts: Date;
}

export interface QuotaCheckResult {
  allowed: boolean;
  remainingDailyTokens: number;
  remainingMonthlyTokens: number | 'unlimited';
  exhaustPolicy: 'downshift' | 'rate_limit' | 'block';
}

export interface CostLedger {
  record(event: Omit<UsageEvent, 'id' | 'ts'>): Promise<UsageEvent>;
  check(tenantId: string, userId: string, estimatedTokens: number): Promise<QuotaCheckResult>;
}
