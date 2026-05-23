import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { readAuth, type AuthContext } from './auth.context';
import { ProblemException } from '../common/problem';

/**
 * Inject the current `AuthContext` into a controller parameter. Throws a
 * typed problem+json `401 unauthenticated` when the request has no auth.
 *
 *   @Get('me')
 *   me(@CurrentUser() user: AuthContext) { ... }
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthContext => {
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    const auth = readAuth(req);
    if (auth === undefined) {
      throw new ProblemException({
        status: 401,
        code: 'unauthenticated',
        title: 'Authentication required',
      });
    }
    return auth;
  },
);
