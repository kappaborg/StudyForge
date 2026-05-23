import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface FeatureFlagDto {
  name: string;
  description: string | null;
  enabled: boolean;
  updatedAt: string;
}

/**
 * Postgres-backed feature flags. Reads pass through the DB (the hot path
 * could cache in-memory with a short TTL; we'll add that when read volume
 * justifies it). Writes are restricted to instructor-portal endpoints.
 *
 * The architectural alternative was an Unleash adapter; we kept it
 * in-house to avoid an external SaaS dependency on the free-product path.
 */
@Injectable()
export class FeatureFlagsService {
  private readonly log = new Logger(FeatureFlagsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<FeatureFlagDto[]> {
    const rows = await this.prisma.featureFlag.findMany({
      orderBy: { name: 'asc' },
    });
    return rows.map((r) => ({
      name: r.name,
      description: r.description,
      enabled: r.enabled,
      updatedAt: r.updatedAt.toISOString(),
    }));
  }

  async setEnabled(name: string, enabled: boolean): Promise<FeatureFlagDto> {
    const row = await this.prisma.featureFlag.upsert({
      where: { name },
      update: { enabled },
      create: { name, enabled },
    });
    this.log.log(`feature-flag.toggle name=${name} enabled=${enabled}`);
    return {
      name: row.name,
      description: row.description,
      enabled: row.enabled,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async isEnabled(name: string): Promise<boolean> {
    const row = await this.prisma.featureFlag.findUnique({ where: { name } });
    return row?.enabled ?? false;
  }
}
