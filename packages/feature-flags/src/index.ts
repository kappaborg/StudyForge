/**
 * Feature-flag contract used by the API and any package that needs to gate
 * code paths. Implementation lives in ``apps/api/src/feature-flags`` and is
 * Postgres-backed (no external Unleash dependency — keeps the product
 * self-hostable and free to run).
 */
export interface FeatureFlagContext {
  tenantId: string;
  userId: string;
  tier: 'free' | 'byok';
  environment: 'development' | 'staging' | 'production';
}

export interface FeatureFlagClient {
  isEnabled(name: string, ctx: FeatureFlagContext): boolean;
  variant(name: string, ctx: FeatureFlagContext): string;
}
