import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { readAuth } from './auth.context';
import type { UserRole } from './auth.context';
import { ROLES_KEY } from './roles.decorator';

/**
 * ``RolesGuard`` consumes the metadata stamped by ``@Roles(...)`` and
 * compares it against the authenticated user's role.
 *
 *   * No metadata → guard is a no-op (every authenticated caller passes).
 *   * Metadata + matching role → pass.
 *   * Metadata + no match → 403 ``ForbiddenException``.
 *   * No auth context on the request → 403 (the caller wasn't
 *     authenticated by the upstream auth middleware; we don't reveal
 *     whether the route exists).
 *
 * Routes that don't decorate any role list still go through the guard
 * because it's mounted globally in ``LtiModule`` (and any future module
 * that wants opt-in role gates). That's intentional — a missing
 * decorator is read as "no role restriction," not as "guard off."
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[] | undefined>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const auth = readAuth(request);
    if (!auth) {
      throw new ForbiddenException('not authenticated');
    }
    if (!required.includes(auth.role)) {
      throw new ForbiddenException(
        `role ${auth.role} not permitted (need one of: ${required.join(', ')})`,
      );
    }
    return true;
  }
}
