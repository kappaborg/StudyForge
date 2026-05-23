import '@fastify/cookie';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { attachAuth, type AuthContext } from './auth.context';
import { AuthService } from './auth.service';
import { SESSION_COOKIE_NAME } from './auth.controller';

/**
 * Hybrid pre-handler for `AUTH_MODE=dev`:
 *
 *  1. If a valid `sf_session` cookie is present, use that user's real
 *     tenant/userId — so signed-in accounts get their isolated workspace
 *     even in dev mode.
 *  2. Otherwise fall back to the `x-tenant-id` / `x-user-id` / `x-user-email`
 *     headers (default to the demo dev user) for unauthenticated calls.
 *
 * Without the cookie-first branch every signed-in user collapses onto the
 * same hardcoded dev tenant and starts seeing each other's materials.
 */

const UNAUTH_PREFIXES = ['/health', '/docs', '/v1/auth', '/v1/lti'];

export function registerDevAuth(app: FastifyInstance, auth: AuthService): void {
  if (process.env['AUTH_MODE'] !== 'dev') return;

  app.addHook('preHandler', async (req: FastifyRequest) => {
    if (UNAUTH_PREFIXES.some((p) => req.url.startsWith(p))) return;

    const cookies = (req as FastifyRequest & { cookies?: Record<string, string> })
      .cookies;
    const sessionToken = cookies?.[SESSION_COOKIE_NAME];
    if (sessionToken) {
      const ctx = await auth.validate(sessionToken);
      if (ctx) {
        attachAuth(req, ctx);
        return;
      }
    }

    const tenantId =
      (req.headers['x-tenant-id'] as string | undefined) ??
      '11111111-1111-1111-1111-111111111111';
    const userId =
      (req.headers['x-user-id'] as string | undefined) ??
      '22222222-2222-2222-2222-222222222222';
    const email =
      (req.headers['x-user-email'] as string | undefined) ?? 'dev@studyforge.ai';
    const roleHeader = req.headers['x-user-role'] as string | undefined;
    const role: AuthContext['role'] = (
      roleHeader === 'instructor' ||
      roleHeader === 'admin' ||
      roleHeader === 'institution_admin'
        ? roleHeader
        : 'student'
    );

    attachAuth(req, { userId, tenantId, email, role });
  });
}
