import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  decryptSecret,
  encryptSecret,
  wrapNewDek,
} from '../security/envelope';
import { ProblemException } from '../common/problem';
import { ByokCreateDto } from './dto/byok-create.dto';
import type { ByokResponseDto } from './dto/byok-response.dto';

/**
 * BYOK lifecycle service. Crypto boundary lives in `apps/api/src/security/envelope.ts`.
 *
 * Invariants:
 *   - Plaintext key NEVER reaches the database, the log formatter, or the
 *     traceparent attributes. Lives only inside the `encryptSecret` /
 *     `decryptSecret` call frames.
 *   - The per-tenant DEK is provisioned lazily on first BYOK add and stored
 *     as `Tenant.wrappedDek` (ciphertext under the KEK).
 *   - `last4` is the only fragment ever rendered to a user.
 */
@Injectable()
export class ByokService {
  private readonly logger = new Logger(ByokService.name);
  private readonly kek: Buffer;

  constructor(private readonly prisma: PrismaService) {
    this.kek = readKek();
  }

  async list(userId: string): Promise<ByokResponseDto[]> {
    const rows = await this.prisma.apiKey.findMany({
      where: { userId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toResponse);
  }

  async create(
    tenantId: string,
    userId: string,
    dto: ByokCreateDto,
    email?: string,
  ): Promise<ByokResponseDto> {
    const wrappedDek = await this.ensureTenantDek(tenantId);
    await this.ensureUser(tenantId, userId, email);
    const last4 = dto.key.slice(-4);

    const existing = await this.prisma.apiKey.findUnique({
      where: { userId_provider_last4: { userId, provider: dto.provider, last4 } },
    });
    if (existing !== null && existing.revokedAt === null) {
      throw new ProblemException({
        status: 409,
        code: 'byok.duplicate',
        title: 'A key with this provider and last-4 fingerprint already exists',
      });
    }

    const encrypted = encryptSecret(dto.key, { wrappedDek }, this.kek);

    const created = await this.prisma.apiKey.create({
      data: {
        tenantId,
        userId,
        provider: dto.provider,
        label: dto.label ?? null,
        last4: encrypted.last4,
        cipher: encrypted.cipher,
        nonce: encrypted.iv,
        tag: encrypted.tag,
        // validatedAt is set when we ping the provider — Phase 1 mid wires this.
      },
    });

    // First active key on the tenant flips it to ``byok`` so the budget
    // service stops counting their requests against the platform daily cap.
    await this.prisma.tenant.update({
      where: { id: tenantId },
      data: { tier: 'byok' },
    });

    // Defensive: never log dto.key, never log encrypted.cipher beyond byte counts.
    this.logger.log(
      `byok.add tenant=${tenantId} user=${userId} provider=${dto.provider} last4=${encrypted.last4}`,
    );

    return toResponse(created);
  }

  async revoke(userId: string, keyId: string): Promise<void> {
    const key = await this.prisma.apiKey.findUnique({ where: { id: keyId } });
    if (key === null || key.userId !== userId) {
      throw new ProblemException({
        status: 404,
        code: 'byok.not-found',
        title: 'BYOK key not found',
      });
    }
    if (key.revokedAt !== null) return;
    await this.prisma.apiKey.update({
      where: { id: keyId },
      data: { revokedAt: new Date() },
    });

    // If this was the tenant's last active key, downgrade them back to the
    // free pool. Budget gating will start counting their requests again.
    const remaining = await this.prisma.apiKey.count({
      where: { tenantId: key.tenantId, revokedAt: null },
    });
    if (remaining === 0) {
      await this.prisma.tenant.update({
        where: { id: key.tenantId },
        data: { tier: 'free' },
      });
    }

    this.logger.log(`byok.revoke user=${userId} id=${keyId}`);
  }

  /**
   * Decrypts the key. Plaintext lives in the returned Buffer only — callers
   * MUST zero it after use. This method is called by the LLM router adapter,
   * not directly by controllers.
   */
  async decryptForCall(userId: string, keyId: string): Promise<Buffer> {
    const key = await this.prisma.apiKey.findUnique({ where: { id: keyId } });
    if (key === null || key.userId !== userId) {
      throw new ProblemException({
        status: 404,
        code: 'byok.not-found',
        title: 'BYOK key not found',
      });
    }
    if (key.revokedAt !== null) {
      throw new ProblemException({
        status: 410,
        code: 'byok.revoked',
        title: 'BYOK key has been revoked',
      });
    }
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: key.tenantId },
    });
    if (tenant?.wrappedDek == null) {
      throw new ProblemException({
        status: 500,
        code: 'byok.tenant-dek-missing',
        title: 'Tenant DEK is missing',
      });
    }
    return decryptSecret(
      { cipher: key.cipher, iv: key.nonce, tag: key.tag, last4: key.last4 },
      { wrappedDek: tenant.wrappedDek },
      this.kek,
    );
  }

  // ── internal ──────────────────────────────────────────────────────────────

  private async ensureTenantDek(tenantId: string): Promise<Buffer> {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
    if (tenant === null) {
      // Dev affordance: provision a personal tenant on demand. Phase 1 mid
      // wires real tenant creation through OAuth signup.
      const wrappedDek = wrapNewDek(this.kek);
      await this.prisma.tenant.create({
        data: {
          id: tenantId,
          name: 'Personal',
          slug: `personal-${tenantId.slice(0, 8)}`,
          wrappedDek,
        },
      });
      return wrappedDek;
    }
    if (tenant.wrappedDek === null) {
      const wrappedDek = wrapNewDek(this.kek);
      await this.prisma.tenant.update({
        where: { id: tenantId },
        data: { wrappedDek },
      });
      return wrappedDek;
    }
    return tenant.wrappedDek;
  }

  private async ensureUser(
    tenantId: string,
    userId: string,
    email: string | undefined,
  ): Promise<void> {
    // Dev affordance: provision the user on first BYOK if it doesn't exist.
    // Phase 1 mid replaces this with the OAuth signup path that creates the
    // User + Tenant atomically.
    const existing = await this.prisma.user.findUnique({ where: { id: userId } });
    if (existing !== null) return;
    await this.prisma.user.create({
      data: {
        id: userId,
        tenantId,
        email: email ?? `dev-${userId.slice(0, 8)}@studyforge.local`,
      },
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

interface ApiKeyRow {
  id: string;
  provider: string;
  last4: string;
  label: string | null;
  createdAt: Date;
  validatedAt: Date | null;
  revokedAt: Date | null;
}

function toResponse(row: ApiKeyRow): ByokResponseDto {
  return {
    id: row.id,
    provider: row.provider,
    last4: row.last4,
    label: row.label,
    createdAt: row.createdAt.toISOString(),
    validatedAt: row.validatedAt === null ? null : row.validatedAt.toISOString(),
    revokedAt: row.revokedAt === null ? null : row.revokedAt.toISOString(),
  };
}

function readKek(): Buffer {
  const raw = process.env['STUDYFORGE_KEK_BASE64'];
  if (raw === undefined || raw === '') {
    throw new Error(
      'STUDYFORGE_KEK_BASE64 is required for BYOK encryption. ' +
        'Generate with: node -e "console.log(crypto.randomBytes(32).toString(\\"base64\\"))"',
    );
  }
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== 32) {
    throw new Error(
      `STUDYFORGE_KEK_BASE64 must decode to 32 bytes; got ${buf.length}.`,
    );
  }
  return buf;
}
