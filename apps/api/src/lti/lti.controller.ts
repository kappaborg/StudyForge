import { Body, Controller, HttpCode, Logger, Post, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import type { FastifyReply } from 'fastify';
import { ProblemException } from '../common/problem';
import { LtiService } from './lti.service';

class LoginDto {
  @IsString() iss!: string;
  @IsString() login_hint!: string;
  @IsString() target_link_uri!: string;
  @IsOptional() @IsString() lti_message_hint?: string;
  @IsOptional() @IsString() lti_deployment_id?: string;
  @IsOptional() @IsString() client_id?: string;
}

class LaunchDto {
  @IsString() id_token!: string;
  @IsOptional() @IsString() state?: string;
}

/**
 * LTI 1.3 endpoints. Two routes:
 *
 *   POST /v1/lti/login   — OIDC login initiation. The platform redirects
 *                          here; we 302 back to the platform's authorize
 *                          endpoint with a nonce + state cookie.
 *   POST /v1/lti/launch  — LTI launch. Receives an id_token; the
 *                          validator (``launch.ts``) verifies the JWS, we
 *                          provision tenant/user, then 302 to /dashboard.
 *
 * The launch validator is wired here but the JWKS fetcher is environment-
 * specific (Canvas, Moodle, Blackboard, IMS reference) — when the
 * deployment supplies its issuer's JWKS URL via env, fetch + verify.
 */
@ApiTags('lti')
@Controller('lti')
export class LtiController {
  private readonly log = new Logger(LtiController.name);

  constructor(private readonly lti: LtiService) {}

  @Post('login')
  @HttpCode(302)
  @ApiOperation({ summary: 'LTI 1.3 OIDC login initiation' })
  async login(
    @Body() dto: LoginDto,
    @Query('redirect_to') redirectTo: string | undefined,
    @Res({ passthrough: true }) res: FastifyReply,
  ): Promise<void> {
    void redirectTo;
    // In a real deployment we'd discover the platform's authorize endpoint
    // via the issuer's well-known config + redirect with a nonce + state
    // cookie. For now, log the initiation; the platform's launch POST
    // will land directly on /v1/lti/launch.
    this.log.log(`lti.login iss=${dto.iss} login_hint=${dto.login_hint}`);
    res.redirect(302, dto.target_link_uri);
  }

  @Post('launch')
  @HttpCode(302)
  @ApiOperation({ summary: 'LTI 1.3 launch — validates id_token, provisions, redirects' })
  async launch(
    @Body() dto: LaunchDto,
    @Res({ passthrough: true }) res: FastifyReply,
  ): Promise<void> {
    if (!dto.id_token) {
      throw new ProblemException({
        status: 400,
        code: 'lti.id-token-missing',
        title: 'LTI id_token is required',
      });
    }
    // Verification is delegated to ``LtiService.verifyOrDecode`` which
    // picks the right trust config for the launch's issuer and runs
    // the full ``verifyLtiLaunch`` against a cached JWKS. Unverified
    // launches only succeed when ``LTI_ALLOW_UNVERIFIED=true`` (or in
    // non-prod), and even then the service logs a loud warning so the
    // dev-mode path is obvious in audit trails.
    try {
      const claims = await this.lti.verifyOrDecode(dto.id_token);
      const { tenantId, userId } = await this.lti.provisionFromLaunch(claims);
      const webBase = process.env['WEB_BASE_URL'] ?? 'http://localhost:3000';
      res.redirect(
        302,
        `${webBase}/dashboard?lti=1&tenant=${tenantId}&user=${userId}`,
      );
    } catch (err) {
      this.log.error(`lti.launch.failed ${err instanceof Error ? err.message : err}`);
      throw new ProblemException({
        status: 401,
        code: 'lti.launch-invalid',
        title: 'LTI launch validation failed',
        detail: err instanceof Error ? err.message : undefined,
      });
    }
  }
}

