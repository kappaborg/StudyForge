import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { LtiClaims } from './launch';

/**
 * LTI 1.3 launch → tenant/user provisioning.
 *
 * Phase-4 scope:
 *   - On every validated launch, ensure ``Institution`` (by ltiIssuer +
 *     deploymentId), ``Tenant`` (institutional kind), and ``User``.
 *   - Capture the AGS lineitems URL + access token if present, so the
 *     quiz-submit code path can ship the score back to the LMS.
 *
 * AGS grade passback itself is a tiny ``send()`` here that, in dev mode
 * (no tool private key registered), only logs the would-be POST. Wire a
 * real signed JWT (scope: ``…/scope/score``) when the deployment ships.
 */
@Injectable()
export class LtiService {
  private readonly log = new Logger(LtiService.name);

  constructor(private readonly prisma: PrismaService) {}

  async provisionFromLaunch(claims: LtiClaims): Promise<{
    institutionId: string;
    tenantId: string;
    userId: string;
  }> {
    const institution = await this.prisma.institution.upsert({
      where: { ltiIssuer: claims.iss },
      update: { ltiClientId: claims.aud, ltiDeploymentId: claims.deploymentId },
      create: {
        name: deriveInstitutionName(claims),
        domain: deriveDomain(claims),
        ltiIssuer: claims.iss,
        ltiClientId: claims.aud,
        ltiDeploymentId: claims.deploymentId,
      },
    });

    // One tenant per institution. Slug derived from the domain to make
    // the URL slug human-friendly.
    let tenant = await this.prisma.tenant.findFirst({
      where: { institutionId: institution.id },
    });
    if (!tenant) {
      tenant = await this.prisma.tenant.create({
        data: {
          name: institution.name,
          slug: institution.domain.replace(/\W+/g, '-'),
          kind: 'institutional',
          institutionId: institution.id,
        },
      });
    }

    // User: keyed on the LTI ``sub`` claim, scoped to the tenant.
    const email = (claims.raw['email'] as string | undefined) ?? `${claims.sub}@${institution.domain}`;
    const user = await this.prisma.user.upsert({
      where: { tenantId_email: { tenantId: tenant.id, email } },
      update: {},
      create: {
        tenantId: tenant.id,
        email,
        oauthProvider: 'lti',
        oauthSub: claims.sub,
      },
    });

    this.log.log(
      `lti.provisioned issuer=${claims.iss} institution=${institution.id} tenant=${tenant.id} user=${user.id}`,
    );
    return { institutionId: institution.id, tenantId: tenant.id, userId: user.id };
  }

  /** Stubbed AGS grade passback. Logs the would-be POST in dev; wire a
   *  signed-JWT POST to the lineitems URL once the tool key is registered
   *  with the platform. */
  async sendGrade(input: {
    lineitemsUrl: string;
    userId: string;
    scoreGiven: number;
    scoreMaximum: number;
    activityProgress?: 'Initialized' | 'Started' | 'InProgress' | 'Submitted' | 'Completed';
    gradingProgress?: 'NotReady' | 'Failed' | 'Pending' | 'PendingManual' | 'FullyGraded';
  }): Promise<{ delivered: boolean }> {
    const toolKey = process.env['LTI_TOOL_PRIVATE_KEY'];
    if (!toolKey) {
      this.log.log(
        `ags.passback.stub lineitems=${input.lineitemsUrl} user=${input.userId} score=${input.scoreGiven}/${input.scoreMaximum}`,
      );
      return { delivered: false };
    }
    // Real implementation:
    //   1. Mint a JWT (aud: platform token endpoint, scope: …/scope/score)
    //   2. POST to lineitems URL with the Score object
    //   3. Parse 202 / 200
    // Skipped here — needs the deployment's tool keypair to be registered
    // first; track the score locally via ``QuizAttempt.score`` and run a
    // backfill once the key is present.
    this.log.warn('ags.passback.unimplemented — tool key present but live passback not wired yet');
    return { delivered: false };
  }
}

function deriveInstitutionName(claims: LtiClaims): string {
  const platform = claims.raw['https://purl.imsglobal.org/spec/lti/claim/tool_platform'] as
    | { name?: string }
    | undefined;
  return platform?.name ?? new URL(claims.iss).hostname;
}

function deriveDomain(claims: LtiClaims): string {
  try {
    return new URL(claims.iss).hostname;
  } catch {
    return 'unknown.lti';
  }
}
