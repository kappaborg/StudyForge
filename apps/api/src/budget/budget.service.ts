import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Per-tenant daily quota for AI calls on the free platform pool.
 *
 * StudyForge is free for everyone. The platform LLM key isn't, so a hard
 * daily cap stops a single tenant from draining the upstream provider.
 * BYOK tenants (``Tenant.tier === 'byok'``) bypass this entirely — their
 * usage doesn't touch the platform pool.
 *
 * "Token budget" survives in the schema name from the original tiered
 * design; the unit we count is AI requests, which is what users intuit
 * and what we can enforce without instrumenting every agent.
 */
@Injectable()
export class BudgetService {
  private static readonly FREE_DAILY_LIMIT = 50; // AI requests per tenant per day
  private static readonly FREE_MONTHLY_LIMIT = 800;

  constructor(private readonly prisma: PrismaService) {}

  async snapshot(tenantId: string): Promise<{
    dailyLimit: number;
    dailyUsed: number;
    dailyRemaining: number;
    monthlyLimit: number;
    monthlyUsed: number;
    dayResetAt: string;
    byok: boolean;
  }> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { tier: true },
    });
    const byok = tenant?.tier === 'byok';
    const row = await this.ensureRow(tenantId);
    return {
      dailyLimit: byok ? -1 : row.dailyLimit,
      dailyUsed: row.dailyUsed,
      dailyRemaining: byok ? -1 : Math.max(0, row.dailyLimit - row.dailyUsed),
      monthlyLimit: byok ? -1 : row.monthlyLimit,
      monthlyUsed: row.monthlyUsed,
      dayResetAt: row.dayResetAt.toISOString(),
      byok,
    };
  }

  /** Returns ``true`` and increments the counter when the call is allowed.
   *  Returns ``false`` when the daily cap is hit (caller should 429). */
  async tryConsume(tenantId: string): Promise<{
    allowed: boolean;
    dailyUsed: number;
    dailyLimit: number;
    dailyRemaining: number;
    byok: boolean;
  }> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { tier: true },
    });
    const byok = tenant?.tier === 'byok';
    if (byok) {
      return {
        allowed: true,
        dailyUsed: 0,
        dailyLimit: -1,
        dailyRemaining: -1,
        byok: true,
      };
    }
    const row = await this.ensureRow(tenantId);
    if (row.dailyUsed >= row.dailyLimit || row.monthlyUsed >= row.monthlyLimit) {
      return {
        allowed: false,
        dailyUsed: row.dailyUsed,
        dailyLimit: row.dailyLimit,
        dailyRemaining: 0,
        byok: false,
      };
    }
    const updated = await this.prisma.tokenBudget.update({
      where: { tenantId },
      data: {
        dailyUsed: { increment: 1 },
        monthlyUsed: { increment: 1 },
      },
    });
    return {
      allowed: true,
      dailyUsed: updated.dailyUsed,
      dailyLimit: updated.dailyLimit,
      dailyRemaining: Math.max(0, updated.dailyLimit - updated.dailyUsed),
      byok: false,
    };
  }

  private async ensureRow(tenantId: string): Promise<{
    tenantId: string;
    dailyLimit: number;
    monthlyLimit: number;
    dailyUsed: number;
    monthlyUsed: number;
    dayResetAt: Date;
    monthResetAt: Date;
  }> {
    const now = new Date();
    const existing = await this.prisma.tokenBudget.findUnique({
      where: { tenantId },
    });
    if (!existing) {
      const dayReset = new Date(now);
      dayReset.setUTCHours(24, 0, 0, 0);
      const monthReset = new Date(now);
      monthReset.setUTCMonth(monthReset.getUTCMonth() + 1, 1);
      monthReset.setUTCHours(0, 0, 0, 0);
      return this.prisma.tokenBudget.create({
        data: {
          tenantId,
          dailyLimit: BudgetService.FREE_DAILY_LIMIT,
          monthlyLimit: BudgetService.FREE_MONTHLY_LIMIT,
          dailyUsed: 0,
          monthlyUsed: 0,
          dayResetAt: dayReset,
          monthResetAt: monthReset,
        },
      });
    }
    // Roll the windows forward.
    const updates: { dailyUsed?: number; monthlyUsed?: number; dayResetAt?: Date; monthResetAt?: Date } = {};
    if (existing.dayResetAt.getTime() <= now.getTime()) {
      const next = new Date(now);
      next.setUTCHours(24, 0, 0, 0);
      updates.dailyUsed = 0;
      updates.dayResetAt = next;
    }
    if (existing.monthResetAt.getTime() <= now.getTime()) {
      const next = new Date(now);
      next.setUTCMonth(next.getUTCMonth() + 1, 1);
      next.setUTCHours(0, 0, 0, 0);
      updates.monthlyUsed = 0;
      updates.monthResetAt = next;
    }
    if (Object.keys(updates).length > 0) {
      return this.prisma.tokenBudget.update({ where: { tenantId }, data: updates });
    }
    return existing;
  }
}
