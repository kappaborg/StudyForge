import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const QUIET_HOURS_START = 22; // 22:00 local
const QUIET_HOURS_END = 7; // 07:00 local
const DAILY_SOFT_CAP = 1; // per channel, per user, per day

type Kind =
  | 'upload_ready'
  | 'milestone_due'
  | 'quiz_due'
  | 'weekly_digest'
  | 'abuse_review'
  | 'billing_warning'
  | 'system';

type Channel = 'email' | 'push' | 'in_app';

interface EnqueueOpts {
  tenantId: string;
  userId: string;
  kind: Kind;
  subject: string;
  body: string;
  // ``in_app`` always delivers — it's the inbox. ``email`` and ``push``
  // honour quiet hours + per-day caps.
  channels?: Channel[];
  meta?: Record<string, unknown>;
}

@Injectable()
export class NotificationsService {
  private readonly log = new Logger(NotificationsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Persist a notification per channel. ``in_app`` is delivered
   *  immediately; ``email`` / ``push`` are queued, with quiet-hour
   *  deferral and per-channel daily caps applied at enqueue time. */
  async enqueue(opts: EnqueueOpts): Promise<{ created: number; suppressed: number }> {
    const channels = opts.channels ?? ['in_app'];
    const now = new Date();
    let created = 0;
    let suppressed = 0;

    for (const channel of channels) {
      const scheduled = channel === 'in_app' ? now : this.scheduleForChannel(channel, now);
      if (scheduled === null) {
        suppressed += 1;
        continue;
      }
      const cap = channel === 'in_app' ? null : await this.recentCount(opts.userId, channel);
      if (cap !== null && cap >= DAILY_SOFT_CAP) {
        suppressed += 1;
        this.log.log(
          `notifications.capped user=${opts.userId} channel=${channel} cap=${DAILY_SOFT_CAP}`,
        );
        continue;
      }
      await this.prisma.notification.create({
        data: {
          tenantId: opts.tenantId,
          userId: opts.userId,
          kind: opts.kind,
          channel,
          subject: opts.subject,
          body: opts.body,
          meta: opts.meta ? (opts.meta as object) : undefined,
          state: channel === 'in_app' ? 'delivered' : 'queued',
          scheduledFor: scheduled,
          deliveredAt: channel === 'in_app' ? now : null,
        },
      });
      created += 1;
    }

    this.log.log(
      `notifications.enqueue user=${opts.userId} kind=${opts.kind} created=${created} suppressed=${suppressed}`,
    );
    return { created, suppressed };
  }

  private scheduleForChannel(channel: 'email' | 'push', now: Date): Date | null {
    const hour = now.getHours();
    const inQuiet =
      QUIET_HOURS_START < QUIET_HOURS_END
        ? hour >= QUIET_HOURS_START && hour < QUIET_HOURS_END
        : hour >= QUIET_HOURS_START || hour < QUIET_HOURS_END;
    if (!inQuiet) return now;
    // Push the delivery to the end of quiet hours (next morning).
    const next = new Date(now);
    next.setHours(QUIET_HOURS_END, 0, 0, 0);
    if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
    return next;
    // No-op for email vs push for now — both follow the same rule.
  }

  private async recentCount(userId: string, channel: 'email' | 'push'): Promise<number> {
    const since = new Date();
    since.setHours(0, 0, 0, 0);
    return this.prisma.notification.count({
      where: { userId, channel, createdAt: { gte: since } },
    });
  }
}
