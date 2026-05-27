import { Body, Controller, Get, HttpCode, Post, Query, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';
import { randomBytes } from 'node:crypto';
import '@fastify/cookie';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ProblemException } from '../common/problem';
import { DemoSeederService } from '../demo/demo-seeder.service';
import { AuthService, type IssuedSession } from './auth.service';
import { readAuth, attachAuth } from './auth.context';

const GOOGLE_STATE_COOKIE = 'sf_google_state';
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';

export const SESSION_COOKIE_NAME = 'sf_session';

class CredentialsDto {
  @IsEmail()
  @MaxLength(256)
  email!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(256)
  password!: string;
}

interface MeDto {
  userId: string;
  tenantId: string;
  email: string;
  role: string;
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly demoSeeder: DemoSeederService,
  ) {}

  @Post('signup')
  @HttpCode(200)
  @ApiOperation({ summary: 'Create an account and start a session' })
  async signup(
    @Body() dto: CredentialsDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<MeDto> {
    const session = await this.auth.signup(dto.email, dto.password, {
      userAgent: pickUserAgent(req),
    });
    setSessionCookie(reply, session);
    return toMe(session);
  }

  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Validate credentials and start a session' })
  async login(
    @Body() dto: CredentialsDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<MeDto> {
    const session = await this.auth.login(dto.email, dto.password, {
      userAgent: pickUserAgent(req),
    });
    setSessionCookie(reply, session);
    return toMe(session);
  }

  @Post('logout')
  @HttpCode(204)
  @ApiOperation({ summary: 'End the current session' })
  async logout(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    const token = readSessionCookie(req);
    if (token) await this.auth.logout(token);
    clearSessionCookie(reply);
  }

  @Get('google/start')
  @ApiOperation({
    summary: 'Begin a Google OAuth sign-in by redirecting to Google',
  })
  async googleStart(
    @Res() reply: FastifyReply,
    @Query('next') next?: string,
  ): Promise<void> {
    const clientId = process.env['GOOGLE_CLIENT_ID'];
    const callbackUrl = process.env['GOOGLE_CALLBACK_URL'];
    if (!clientId || !callbackUrl) {
      throw new ProblemException({
        status: 500,
        code: 'auth.google-not-configured',
        title: 'Google sign-in is not configured on this server',
        detail:
          'Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_CALLBACK_URL.',
      });
    }
    // Random state token, bound to the user's cookie jar. We verify it on
    // the callback to defeat cross-site request forgery against the OAuth
    // flow. The ``next`` query string is folded into the state so we can
    // bounce the user back to their original deep-link after sign-in.
    const stateToken = randomBytes(24).toString('base64url');
    const payload = JSON.stringify({ s: stateToken, n: sanitizeNext(next) });
    const encoded = Buffer.from(payload).toString('base64url');
    reply.setCookie(GOOGLE_STATE_COOKIE, stateToken, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env['NODE_ENV'] === 'production',
      // Short-lived — the user should complete sign-in within ~10 minutes.
      maxAge: 10 * 60,
    });
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: callbackUrl,
      response_type: 'code',
      scope: 'openid email profile',
      access_type: 'online',
      include_granted_scopes: 'true',
      state: encoded,
      prompt: 'select_account',
    });
    reply.redirect(`${GOOGLE_AUTH_URL}?${params.toString()}`, 302);
  }

  @Get('google/callback')
  @ApiOperation({
    summary: 'OAuth callback — exchanges the code, issues a session, redirects',
  })
  async googleCallback(
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
    @Query('code') code?: string,
    @Query('state') state?: string,
    @Query('error') error?: string,
  ): Promise<void> {
    const webBase = process.env['WEB_BASE_URL'] ?? 'http://localhost:3000';
    if (error) {
      // User clicked "cancel" on Google's consent screen, or Google
      // surfaced an error. Bounce back with a hint, don't 500.
      reply.redirect(
        `${webBase}/login?error=${encodeURIComponent(error)}`,
        302,
      );
      return;
    }
    if (!code || !state) {
      reply.redirect(`${webBase}/login?error=invalid_callback`, 302);
      return;
    }
    // Verify state cookie. Missing / mismatched → reject (CSRF defence).
    const cookies = (req as FastifyRequest & { cookies?: Record<string, string> })
      .cookies;
    const cookieState = cookies?.[GOOGLE_STATE_COOKIE];
    let next = '/dashboard';
    try {
      const decoded = JSON.parse(
        Buffer.from(state, 'base64url').toString('utf8'),
      ) as { s?: string; n?: string };
      if (!decoded.s || decoded.s !== cookieState) {
        throw new Error('state mismatch');
      }
      if (typeof decoded.n === 'string') next = decoded.n;
    } catch {
      reply.redirect(`${webBase}/login?error=state_mismatch`, 302);
      return;
    }
    reply.clearCookie(GOOGLE_STATE_COOKIE, { path: '/' });

    const clientId = process.env['GOOGLE_CLIENT_ID'];
    const clientSecret = process.env['GOOGLE_CLIENT_SECRET'];
    const callbackUrl = process.env['GOOGLE_CALLBACK_URL'];
    if (!clientId || !clientSecret || !callbackUrl) {
      reply.redirect(`${webBase}/login?error=server_misconfigured`, 302);
      return;
    }

    // Exchange the auth code for an access token.
    let accessToken: string;
    try {
      const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: callbackUrl,
          grant_type: 'authorization_code',
        }).toString(),
      });
      if (!tokenRes.ok) {
        throw new Error(`token exchange ${tokenRes.status}`);
      }
      const tokenJson = (await tokenRes.json()) as { access_token?: string };
      if (!tokenJson.access_token) throw new Error('no access_token in response');
      accessToken = tokenJson.access_token;
    } catch (err) {
      reply.redirect(
        `${webBase}/login?error=${encodeURIComponent(`token_exchange:${err}`)}`,
        302,
      );
      return;
    }

    // Fetch user info. We deliberately use the userinfo endpoint instead of
    // verifying the ID token JWT to avoid pulling in a JWKS client; the
    // userinfo call is cheap and Google's TLS terminates the trust chain.
    let profile: { sub: string; email: string; email_verified: boolean };
    try {
      const userRes = await fetch(GOOGLE_USERINFO_URL, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!userRes.ok) throw new Error(`userinfo ${userRes.status}`);
      profile = (await userRes.json()) as typeof profile;
      if (!profile.sub || !profile.email) {
        throw new Error('profile missing sub/email');
      }
    } catch (err) {
      reply.redirect(
        `${webBase}/login?error=${encodeURIComponent(`userinfo:${err}`)}`,
        302,
      );
      return;
    }

    const session = await this.auth.loginViaGoogle(
      {
        sub: profile.sub,
        email: profile.email,
        emailVerified: !!profile.email_verified,
      },
      { userAgent: pickUserAgent(req) },
    );
    setSessionCookie(reply, session);
    // Seed demo content for brand-new tenants. Fire-and-forget so we
    // don't add latency to the redirect; the seeder is idempotent and
    // never throws past its own try/catch.
    if (session.isNewUser) {
      void this.demoSeeder.seedForTenant(
        session.user.tenantId,
        session.user.userId,
      );
    }
    reply.redirect(`${webBase}${next}`, 302);
  }

  @Get('me')
  @HttpCode(200)
  @ApiOperation({ summary: 'Return the active user, if any' })
  async me(@Req() req: FastifyRequest): Promise<MeDto> {
    let ctx = readAuth(req);
    if (!ctx) {
      // /v1/auth/me is exempted from the cookie guard so the client can poll
      // it on bootstrap. Resolve the session ourselves.
      const token = readSessionCookie(req);
      if (token) {
        const v = await this.auth.validate(token);
        if (v) {
          attachAuth(req, v);
          ctx = v;
        }
      }
    }
    if (!ctx) {
      throw new ProblemException({
        status: 401,
        code: 'auth.unauthenticated',
        title: 'Not signed in',
      });
    }
    return {
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      email: ctx.email,
      role: ctx.role,
    };
  }
}

function setSessionCookie(reply: FastifyReply, session: IssuedSession): void {
  const secure = process.env['NODE_ENV'] === 'production';
  reply.setCookie(SESSION_COOKIE_NAME, session.token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure,
    expires: session.expiresAt,
  });
}

function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
}

function readSessionCookie(req: FastifyRequest): string | null {
  const cookies = (req as FastifyRequest & { cookies?: Record<string, string> }).cookies;
  return cookies?.[SESSION_COOKIE_NAME] ?? null;
}

function pickUserAgent(req: FastifyRequest): string | undefined {
  const ua = req.headers['user-agent'];
  if (typeof ua !== 'string') return undefined;
  return ua.slice(0, 256);
}

/**
 * Restrict the post-OAuth redirect target to same-origin app routes. Without
 * this, an attacker could craft a sign-in link that bounces the user to an
 * arbitrary external URL after they authenticate.
 */
function sanitizeNext(next: string | undefined): string {
  if (!next || typeof next !== 'string') return '/dashboard';
  if (!next.startsWith('/')) return '/dashboard';
  if (next.startsWith('//')) return '/dashboard';
  return next.slice(0, 256);
}

function toMe(session: IssuedSession): MeDto {
  return {
    userId: session.user.userId,
    tenantId: session.user.tenantId,
    email: session.user.email,
    role: session.user.role,
  };
}
