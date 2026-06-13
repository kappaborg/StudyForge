import { Test } from '@nestjs/testing';
import { LtiAdminController } from './lti-admin.controller';
import { PrismaService } from '../prisma/prisma.service';
import { ProblemException } from '../common/problem';
import type { AuthContext } from '../auth/auth.context';

interface FakePrismaState {
  institutions: Array<{
    id: string;
    name: string;
    domain: string;
    ltiIssuer: string | null;
    ltiClientId: string | null;
    ltiDeploymentId: string | null;
    ltiJwksUri: string | null;
    samlMetadata: string | null;
    createdAt: Date;
    deletedAt: Date | null;
  }>;
}

function makeFakePrisma(state: FakePrismaState): PrismaService {
  const fail = (code: string) => {
    const e: Error & { code?: string } = new Error('unique constraint');
    e.code = code;
    return e;
  };
  return {
    institution: {
      upsert: jest.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { ltiIssuer: string };
          create: Partial<FakePrismaState['institutions'][0]>;
          update: Partial<FakePrismaState['institutions'][0]>;
        }) => {
          const existing = state.institutions.find(
            (i) => i.ltiIssuer === where.ltiIssuer,
          );
          if (existing) {
            Object.assign(existing, update);
            return existing;
          }
          // Simulate the ``Institution.domain @unique`` constraint
          // when a NEW row tries to use a domain another row already
          // holds.
          if (
            create.domain &&
            state.institutions.some((i) => i.domain === create.domain)
          ) {
            throw fail('P2002');
          }
          const row = {
            id: `inst-${state.institutions.length + 1}`,
            name: create.name ?? '',
            domain: create.domain ?? '',
            ltiIssuer: create.ltiIssuer ?? null,
            ltiClientId: create.ltiClientId ?? null,
            ltiDeploymentId: create.ltiDeploymentId ?? null,
            ltiJwksUri: create.ltiJwksUri ?? null,
            samlMetadata: create.samlMetadata ?? null,
            createdAt: new Date(),
            deletedAt: null,
          };
          state.institutions.push(row);
          return row;
        },
      ),
      findMany: jest.fn(
        async ({
          where,
          orderBy: _orderBy,
          take,
        }: {
          where: { ltiIssuer: object; deletedAt: null };
          orderBy: object;
          take?: number;
        }) => {
          // ``where`` shape is asserted only to surface type drift; the
          // fake actually filters in code above.
          void where;
          const filtered = state.institutions
            .filter((i) => i.ltiIssuer !== null && i.deletedAt === null)
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
          return take ? filtered.slice(0, take) : filtered;
        },
      ),
    },
  } as unknown as PrismaService;
}

// Note: role-based authorization is enforced by ``RolesGuard`` (see
// ``roles.guard.spec.ts``), not by the controller method itself. These
// tests invoke the method directly to verify business logic — the
// guard never runs at this layer.

const ADMIN: AuthContext = {
  userId: 'u-admin',
  tenantId: 't',
  email: 'a@x.com',
  role: 'admin',
};

const VALID_DTO = {
  name: 'Canvas Demo',
  domain: 'canvas.example.edu',
  ltiIssuer: 'https://canvas.example.edu',
  ltiClientId: 'client-abc',
  ltiDeploymentId: 'deploy-1',
  ltiJwksUri: 'https://canvas.example.edu/api/lti/security/jwks',
};

async function makeCtl(state: FakePrismaState): Promise<LtiAdminController> {
  const moduleRef = await Test.createTestingModule({
    controllers: [LtiAdminController],
    providers: [{ provide: PrismaService, useValue: makeFakePrisma(state) }],
  }).compile();
  return moduleRef.get(LtiAdminController);
}

describe('LtiAdminController', () => {
  describe('register upsert behaviour', () => {
    it('creates a new institution on first registration', async () => {
      const state: FakePrismaState = { institutions: [] };
      const ctl = await makeCtl(state);
      await ctl.registerPlatform(ADMIN, VALID_DTO);
      expect(state.institutions).toHaveLength(1);
      expect(state.institutions[0]?.ltiJwksUri).toBe(VALID_DTO.ltiJwksUri);
    });

    it('rewrites jwks_uri + clientId on key rotation (re-register same issuer)', async () => {
      const state: FakePrismaState = { institutions: [] };
      const ctl = await makeCtl(state);
      await ctl.registerPlatform(ADMIN, VALID_DTO);

      const rotated = {
        ...VALID_DTO,
        ltiJwksUri: 'https://canvas.example.edu/new/jwks',
        ltiClientId: 'client-xyz',
      };
      const after = await ctl.registerPlatform(ADMIN, rotated);
      expect(state.institutions).toHaveLength(1);
      expect(after.ltiJwksUri).toBe('https://canvas.example.edu/new/jwks');
      expect(after.ltiClientId).toBe('client-xyz');
    });

    it('returns 409 (ProblemException) when a different issuer wants a taken domain', async () => {
      const state: FakePrismaState = {
        institutions: [
          {
            id: 'inst-1',
            name: 'Existing',
            domain: 'shared.edu',
            ltiIssuer: 'https://existing.edu',
            ltiClientId: 'c1',
            ltiDeploymentId: 'd1',
            ltiJwksUri: 'https://existing.edu/jwks',
            samlMetadata: null,
            createdAt: new Date(),
            deletedAt: null,
          },
        ],
      };
      const ctl = await makeCtl(state);
      const conflict = {
        ...VALID_DTO,
        domain: 'shared.edu', // collides
        ltiIssuer: 'https://new.edu',
      };
      await expect(ctl.registerPlatform(ADMIN, conflict)).rejects.toThrow(
        ProblemException,
      );
    });
  });

  describe('list', () => {
    it('returns LTI-registered institutions only', async () => {
      const state: FakePrismaState = {
        institutions: [
          {
            id: 'inst-1',
            name: 'Has LTI',
            domain: 'a.edu',
            ltiIssuer: 'https://a.edu',
            ltiClientId: 'c',
            ltiDeploymentId: 'd',
            ltiJwksUri: 'https://a.edu/jwks',
            samlMetadata: null,
            createdAt: new Date('2026-01-01'),
            deletedAt: null,
          },
          {
            id: 'inst-2',
            name: 'No LTI',
            domain: 'b.edu',
            ltiIssuer: null,
            ltiClientId: null,
            ltiDeploymentId: null,
            ltiJwksUri: null,
            samlMetadata: null,
            createdAt: new Date('2026-01-02'),
            deletedAt: null,
          },
        ],
      };
      const ctl = await makeCtl(state);
      const { platforms } = await ctl.listPlatforms(ADMIN);
      expect(platforms).toHaveLength(1);
      expect(platforms[0]?.ltiIssuer).toBe('https://a.edu');
    });
  });
});
