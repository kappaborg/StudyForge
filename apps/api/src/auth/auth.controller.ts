import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';
import '@fastify/cookie';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ProblemException } from '../common/problem';
import { AuthService, type IssuedSession } from './auth.service';
import { readAuth, attachAuth } from './auth.context';

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
  constructor(private readonly auth: AuthService) {}

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

function toMe(session: IssuedSession): MeDto {
  return {
    userId: session.user.userId,
    tenantId: session.user.tenantId,
    email: session.user.email,
    role: session.user.role,
  };
}
