import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface StreakDto {
  currentStreak: number;
  longestStreak: number;
  totalActiveDays: number;
  lastActiveDate: string | null;
  // null when the user has never been active; otherwise a UTC date.
  // The FE uses this to show "due to break tomorrow" copy.
  active: boolean; // true == user already counted today
}

@Injectable()
export class StreaksService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Idempotent per-day: called from SRS-review and quiz-submit hooks.
   * First call of the day extends (or resets) the streak; subsequent
   * calls the same UTC day are no-ops.
   */
  async recordActivity(userId: string): Promise<StreakDto> {
    const today = startOfUtcDay(new Date());
    const existing = await this.prisma.userStreak.findUnique({ where: { userId } });

    if (!existing) {
      // First-ever active day. Lazy-create.
      const row = await this.prisma.userStreak.create({
        data: {
          userId,
          currentStreak: 1,
          longestStreak: 1,
          totalActiveDays: 1,
          lastActiveDate: today,
        },
      });
      return toDto(row, today);
    }

    if (existing.lastActiveDate && sameUtcDay(existing.lastActiveDate, today)) {
      // Already counted today.
      return toDto(existing, today);
    }

    // Compute the new current streak. If the gap is exactly 1 day,
    // continue; otherwise reset. ``null`` last-active falls through to
    // reset == 1 (effectively a first day).
    let nextCurrent = 1;
    if (existing.lastActiveDate) {
      const gap = daysBetween(existing.lastActiveDate, today);
      if (gap === 1) nextCurrent = existing.currentStreak + 1;
      else if (gap === 0) nextCurrent = existing.currentStreak; // safety
      else nextCurrent = 1;
    }

    const nextLongest = Math.max(existing.longestStreak, nextCurrent);
    const row = await this.prisma.userStreak.update({
      where: { userId },
      data: {
        currentStreak: nextCurrent,
        longestStreak: nextLongest,
        totalActiveDays: existing.totalActiveDays + 1,
        lastActiveDate: today,
      },
    });
    return toDto(row, today);
  }

  /**
   * Read-only fetch for the UI. Auto-decays the displayed current streak
   * to 0 if more than one full day has passed since lastActiveDate —
   * better to show "0 · 14 best" than a stale "14" that's actually broken
   * until the next recordActivity call.
   */
  async getForUser(userId: string): Promise<StreakDto> {
    const today = startOfUtcDay(new Date());
    const row = await this.prisma.userStreak.findUnique({ where: { userId } });
    if (!row) {
      return {
        currentStreak: 0,
        longestStreak: 0,
        totalActiveDays: 0,
        lastActiveDate: null,
        active: false,
      };
    }
    const decayed = decayCurrent(row, today);
    return toDto({ ...row, currentStreak: decayed }, today);
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function sameUtcDay(a: Date, b: Date): boolean {
  return startOfUtcDay(a).getTime() === startOfUtcDay(b).getTime();
}

function daysBetween(earlier: Date, later: Date): number {
  const a = startOfUtcDay(earlier).getTime();
  const b = startOfUtcDay(later).getTime();
  return Math.round((b - a) / 86_400_000);
}

function decayCurrent(
  row: { lastActiveDate: Date | null; currentStreak: number },
  today: Date,
): number {
  if (!row.lastActiveDate) return 0;
  const gap = daysBetween(row.lastActiveDate, today);
  // gap 0 = today (just active), 1 = yesterday (still alive), >1 = broken.
  if (gap <= 1) return row.currentStreak;
  return 0;
}

function toDto(
  row: {
    currentStreak: number;
    longestStreak: number;
    totalActiveDays: number;
    lastActiveDate: Date | null;
  },
  today: Date,
): StreakDto {
  return {
    currentStreak: row.currentStreak,
    longestStreak: row.longestStreak,
    totalActiveDays: row.totalActiveDays,
    lastActiveDate: row.lastActiveDate?.toISOString() ?? null,
    active: row.lastActiveDate ? sameUtcDay(row.lastActiveDate, today) : false,
  };
}
