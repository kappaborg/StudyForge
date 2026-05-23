import { Injectable, Logger } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { ProblemException } from '../common/problem';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthContext } from './auth.context';

// Cost factor tuned for ~250ms on a modern laptop CPU. High enough to slow
// online brute force; low enough that login latency stays acceptable.
const BCRYPT_COST = 12;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MIN_PASSWORD_LEN = 8;
const MAX_PASSWORD_LEN = 256;

export interface IssuedSession {
  token: string;
  expiresAt: Date;
  user: AuthContext;
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function newToken(): string {
  // 48 random bytes ≈ 256 bits of entropy. base64url keeps it cookie-safe.
  return randomBytes(48).toString('base64url');
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'user'
  );
}

@Injectable()
export class AuthService {
  private readonly log = new Logger(AuthService.name);

  constructor(private readonly prisma: PrismaService) {}

  async signup(
    email: string,
    password: string,
    meta: { userAgent?: string; ipHash?: string } = {},
  ): Promise<IssuedSession> {
    this.validatePassword(password);
    const normalized = email.trim().toLowerCase();
    if (!normalized.includes('@')) {
      throw new ProblemException({
        status: 400,
        code: 'auth.invalid-email',
        title: 'Invalid email address',
      });
    }

    const existing = await this.prisma.user.findFirst({
      where: { email: normalized, deletedAt: null },
    });
    if (existing) {
      throw new ProblemException({
        status: 409,
        code: 'auth.email-taken',
        title: 'Email already registered',
        detail: 'An account with this email already exists. Try logging in.',
      });
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
    // Per-user tenant. Isolates folders, documents, artifacts, and chat
    // sessions by construction — the rest of the codebase already scopes by
    // tenantId, so a fresh tenant per signup is the cheapest way to get
    // hard data isolation.
    const baseName = normalized.split('@')[0] || normalized;
    const tenant = await this.prisma.tenant.create({
      data: {
        name: baseName,
        // Tenant slugs are globally unique. Append a short random suffix so
        // two users with the same local-part (alice@a.com, alice@b.com)
        // don't collide.
        slug: `${slugify(baseName)}-${randomBytes(4).toString('hex')}`,
      },
    });
    const user = await this.prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: normalized,
        passwordHash,
        emailVerified: false,
      },
    });

    return this.issueSession(user, meta);
  }

  async login(
    email: string,
    password: string,
    meta: { userAgent?: string; ipHash?: string } = {},
  ): Promise<IssuedSession> {
    const normalized = email.trim().toLowerCase();
    const user = await this.prisma.user.findFirst({
      where: { email: normalized, deletedAt: null },
    });
    // Always run bcrypt.compare to keep timing constant whether or not the
    // user exists — leaks email enumeration otherwise.
    const stored =
      user?.passwordHash ??
      '$2a$12$0000000000000000000000.0000000000000000000000000000000000';
    const ok = await bcrypt.compare(password, stored);
    if (!user || !user.passwordHash || !ok) {
      throw new ProblemException({
        status: 401,
        code: 'auth.invalid-credentials',
        title: 'Invalid email or password',
      });
    }
    return this.issueSession(user, meta);
  }

  async logout(token: string): Promise<void> {
    const tokenHash = sha256(token);
    await this.prisma.session.deleteMany({ where: { tokenHash } });
  }

  async validate(token: string): Promise<AuthContext | null> {
    const tokenHash = sha256(token);
    const session = await this.prisma.session.findUnique({
      where: { tokenHash },
      include: { user: true },
    });
    if (!session) return null;
    if (session.expiresAt < new Date()) {
      // Drop expired sessions opportunistically on access.
      await this.prisma.session.delete({ where: { id: session.id } }).catch(() => undefined);
      return null;
    }
    if (session.user.deletedAt) return null;
    // Touch lastSeenAt without blocking the request hot path.
    void this.prisma.session
      .update({ where: { id: session.id }, data: { lastSeenAt: new Date() } })
      .catch(() => undefined);
    return {
      userId: session.userId,
      tenantId: session.user.tenantId,
      email: session.user.email,
      role: session.user.role,
    };
  }

  async meById(userId: string): Promise<AuthContext | null> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.deletedAt) return null;
    return {
      userId: user.id,
      tenantId: user.tenantId,
      email: user.email,
      role: user.role,
    };
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private validatePassword(password: string): void {
    if (
      password.length < MIN_PASSWORD_LEN ||
      password.length > MAX_PASSWORD_LEN
    ) {
      throw new ProblemException({
        status: 400,
        code: 'auth.weak-password',
        title: 'Password does not meet requirements',
        detail: `Passwords must be ${MIN_PASSWORD_LEN}–${MAX_PASSWORD_LEN} characters.`,
      });
    }
  }

  private async issueSession(
    user: { id: string; tenantId: string; email: string; role: AuthContext['role'] },
    meta: { userAgent?: string; ipHash?: string },
  ): Promise<IssuedSession> {
    const token = newToken();
    const tokenHash = sha256(token);
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await this.prisma.session.create({
      data: {
        userId: user.id,
        tokenHash,
        expiresAt,
        userAgent: meta.userAgent ?? null,
        ipHash: meta.ipHash ?? null,
      },
    });
    this.log.log(`session.issued user=${user.id.slice(0, 8)} ttl=${SESSION_TTL_MS}ms`);
    return {
      token,
      expiresAt,
      user: {
        userId: user.id,
        tenantId: user.tenantId,
        email: user.email,
        role: user.role,
      },
    };
  }
}
