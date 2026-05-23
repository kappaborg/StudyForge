import '@fastify/cookie';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { attachAuth } from './auth.context';
import { AuthService } from './auth.service';
import { SESSION_COOKIE_NAME } from './auth.controller';

// Paths that resolve without an authenticated session. Everything else
// returns 401 when no valid session is attached.
const UNAUTH_PREFIXES = ['/health', '/docs', '/v1/auth', '/v1/lti'];

/**
 * Cookie-backed session auth. When AUTH_MODE !== 'dev', this hook runs in
 * place of the dev header plugin: it reads `sf_session`, looks up the
 * matching Session row (by tokenHash), and attaches an AuthContext.
 *
 * Unauthenticated requests to protected paths get a 401 with a problem
 * detail — the FE middleware redirects to /login on that signal.
 */
export function registerSessionAuth(app: FastifyInstance, auth: AuthService): void {
  if (process.env['AUTH_MODE'] === 'dev') return;

  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    if (UNAUTH_PREFIXES.some((p) => req.url.startsWith(p))) return;

    const cookies = (req as FastifyRequest & { cookies?: Record<string, string> })
      .cookies;
    const token = cookies?.[SESSION_COOKIE_NAME];
    if (!token) {
      reply.code(401).send({
        type: 'about:blank',
        title: 'Not signed in',
        status: 401,
        code: 'auth.unauthenticated',
      });
      return;
    }
    const ctx = await auth.validate(token);
    if (!ctx) {
      reply.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
      reply.code(401).send({
        type: 'about:blank',
        title: 'Session expired',
        status: 401,
        code: 'auth.session-expired',
      });
      return;
    }
    attachAuth(req, ctx);
  });
}
