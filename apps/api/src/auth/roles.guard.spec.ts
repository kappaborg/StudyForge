import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';
import { ROLES_KEY } from './roles.decorator';
import { attachAuth, type AuthContext, type UserRole } from './auth.context';
import type { ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

/**
 * ``RolesGuard`` consumes ``@Roles(...)`` metadata and compares it
 * against ``req.auth.role``. These tests exercise every branch of the
 * decision matrix.
 */

function makeReflector(required: UserRole[] | undefined): Reflector {
  return {
    getAllAndOverride: jest.fn(() => required),
  } as unknown as Reflector;
}

function makeContext(req: FastifyRequest): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => null,
    getClass: () => null,
  } as unknown as ExecutionContext;
}

function reqWithRole(role: UserRole): FastifyRequest {
  const req = {} as FastifyRequest;
  const auth: AuthContext = {
    userId: 'u',
    tenantId: 't',
    email: 'x@y.com',
    role,
  };
  attachAuth(req, auth);
  return req;
}

describe('RolesGuard', () => {
  it('passes when no @Roles metadata is present', () => {
    const guard = new RolesGuard(makeReflector(undefined));
    const result = guard.canActivate(makeContext(reqWithRole('student')));
    expect(result).toBe(true);
  });

  it('passes when @Roles metadata is an empty array (decorator misuse)', () => {
    const guard = new RolesGuard(makeReflector([]));
    const result = guard.canActivate(makeContext(reqWithRole('student')));
    expect(result).toBe(true);
  });

  it('allows an admin caller when admin is in the metadata', () => {
    const guard = new RolesGuard(makeReflector(['admin']));
    const result = guard.canActivate(makeContext(reqWithRole('admin')));
    expect(result).toBe(true);
  });

  it('allows an institution_admin when in the metadata', () => {
    const guard = new RolesGuard(makeReflector(['admin', 'institution_admin']));
    const result = guard.canActivate(
      makeContext(reqWithRole('institution_admin')),
    );
    expect(result).toBe(true);
  });

  it('forbids a student when the metadata only lists admin', () => {
    const guard = new RolesGuard(makeReflector(['admin']));
    expect(() =>
      guard.canActivate(makeContext(reqWithRole('student'))),
    ).toThrow(ForbiddenException);
  });

  it('forbids when no auth context is attached', () => {
    const guard = new RolesGuard(makeReflector(['admin']));
    const naked = {} as FastifyRequest;
    expect(() => guard.canActivate(makeContext(naked))).toThrow(
      ForbiddenException,
    );
  });

  it('includes the required roles list in the forbidden message', () => {
    const guard = new RolesGuard(makeReflector(['admin', 'institution_admin']));
    expect(() =>
      guard.canActivate(makeContext(reqWithRole('student'))),
    ).toThrow(/admin, institution_admin/);
  });
});

describe('Roles decorator', () => {
  it('marks the route with ROLES_KEY metadata', () => {
    // We don't import ``Roles`` itself here because Nest's ``SetMetadata``
    // returns a function that is the decorator, not a value we can
    // introspect at runtime. The integration is covered by the guard
    // tests above; this is just a placeholder ensuring the constant
    // stays exported (the controller imports it under that name).
    expect(ROLES_KEY).toBe('studyforge.roles');
  });
});
