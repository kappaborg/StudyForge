import type { FastifyRequest } from 'fastify';

/**
 * Per-request auth context. Populated by `dev-auth.middleware.ts` (Phase 1)
 * and later by the real OAuth flow (Phase 1 mid). Production code reads from
 * here exclusively — never from headers directly.
 */
export type UserRole = 'student' | 'instructor' | 'admin' | 'institution_admin';

export interface AuthContext {
  userId: string;
  tenantId: string;
  email: string;
  role: UserRole;
}

const STORE_KEY = '_studyforgeAuth';

export function attachAuth(req: FastifyRequest, ctx: AuthContext): void {
  (req as FastifyRequest & Record<string, unknown>)[STORE_KEY] = ctx;
}

export function readAuth(req: FastifyRequest): AuthContext | undefined {
  const raw = (req as FastifyRequest & Record<string, unknown>)[STORE_KEY];
  return raw as AuthContext | undefined;
}
