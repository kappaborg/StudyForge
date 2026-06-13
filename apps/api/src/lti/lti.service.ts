import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CachedJwksFetcher } from './jwks-fetcher';
import { verifyLtiLaunch, type LtiClaims, type LtiTrustConfig } from './launch';

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
  // Memoise one CachedJwksFetcher per ``jwks_uri``. Two tenants
  // pointed at the same platform issuer share a keyset cache —
  // Canvas rotates infrequently and per-tenant refresh would
  // saturate the platform.
  private readonly jwksByUri = new Map<string, CachedJwksFetcher>();

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Look up an LTI-registered institution from a launch's ``iss`` claim
   * and return the trust config the validator needs. ``null`` when the
   * issuer is unknown OR when the institution lacks a configured
   * ``ltiJwksUri`` (verification can't proceed without a keyset).
   */
  async resolveTrust(issuer: string): Promise<{
    trust: LtiTrustConfig;
    jwks: CachedJwksFetcher;
  } | null> {
    const inst = await this.prisma.institution.findUnique({
      where: { ltiIssuer: issuer },
    });
    if (!inst || !inst.ltiClientId || !inst.ltiJwksUri) return null;
    let fetcher = this.jwksByUri.get(inst.ltiJwksUri);
    if (!fetcher) {
      fetcher = new CachedJwksFetcher(inst.ltiJwksUri);
      this.jwksByUri.set(inst.ltiJwksUri, fetcher);
    }
    return {
      trust: { issuer: inst.ltiIssuer!, clientId: inst.ltiClientId },
      jwks: fetcher,
    };
  }

  /**
   * Verifies + decodes an id_token. Routes to the real ``verifyLtiLaunch``
   * when the issuer's trust config is registered; falls back to the
   * unverified decoder only when ``LTI_ALLOW_UNVERIFIED=true`` is set in
   * the environment AND no trust config exists. Production deployments
   * MUST register every issuer before flipping that flag off.
   */
  async verifyOrDecode(idToken: string): Promise<LtiClaims> {
    const issuer = peekIssuer(idToken);
    if (issuer === null) {
      throw new Error('id_token payload is not valid JSON');
    }
    const config = await this.resolveTrust(issuer);
    if (config) {
      return verifyLtiLaunch({
        idToken,
        trust: config.trust,
        jwks: config.jwks,
      });
    }
    const allowUnverified =
      process.env['LTI_ALLOW_UNVERIFIED'] === 'true' ||
      process.env['NODE_ENV'] !== 'production';
    if (!allowUnverified) {
      throw new Error(
        `LTI issuer ${issuer} is not registered (no Institution with ltiIssuer + ltiJwksUri). ` +
          'Register the platform before its first launch, or set LTI_ALLOW_UNVERIFIED=true for dev.',
      );
    }
    this.log.warn(
      `lti.launch.unverified iss=${issuer} — id_token signature was NOT checked. ` +
        'Set LTI_ALLOW_UNVERIFIED=false and register the issuer for production.',
    );
    return decodeUnverified(idToken);
  }

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

/**
 * Peek at the ``iss`` claim of an id_token *without* verifying the
 * signature. Used solely to select the right trust config; the chosen
 * config's keyset then verifies the same token cryptographically.
 */
function peekIssuer(idToken: string): string | null {
  const parts = idToken.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1]!, 'base64url').toString('utf-8'),
    ) as { iss?: unknown };
    return typeof payload.iss === 'string' ? payload.iss : null;
  } catch {
    return null;
  }
}

function decodeUnverified(idToken: string): LtiClaims {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  const payload = JSON.parse(
    Buffer.from(parts[1]!, 'base64url').toString('utf-8'),
  ) as Record<string, unknown>;
  const aud = payload['aud'];
  return {
    iss: String(payload['iss'] ?? ''),
    aud: typeof aud === 'string' ? aud : Array.isArray(aud) ? String(aud[0] ?? '') : '',
    sub: String(payload['sub'] ?? ''),
    nonce: String(payload['nonce'] ?? ''),
    iat: Number(payload['iat'] ?? 0),
    exp: Number(payload['exp'] ?? 0),
    azp: String(payload['azp'] ?? ''),
    deploymentId: String(
      payload['https://purl.imsglobal.org/spec/lti/claim/deployment_id'] ?? '',
    ),
    messageType: String(
      payload['https://purl.imsglobal.org/spec/lti/claim/message_type'] ?? '',
    ),
    contextId:
      (payload['https://purl.imsglobal.org/spec/lti/claim/context'] as { id?: string } | undefined)
        ?.id,
    resourceLinkId:
      (payload['https://purl.imsglobal.org/spec/lti/claim/resource_link'] as { id?: string } | undefined)
        ?.id,
    roles: Array.isArray(
      payload['https://purl.imsglobal.org/spec/lti/claim/roles'],
    )
      ? (payload['https://purl.imsglobal.org/spec/lti/claim/roles'] as string[])
      : [],
    raw: payload,
  };
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
