import type { Context } from './context.js';

// Pulls one email-channel notification at a time, atomically transitions
// it to ``sending``, looks up the recipient, calls Resend, and lands the
// row in ``delivered`` (success) or ``failed`` (terminal — v1 has no
// retry-count column). Caller (``main.ts``) loops up to ``maxPerTick``
// before sleeping.
//
// We dispatch one-at-a-time intentionally:
//   * a slow Resend response shouldn't block the next one
//   * a transient failure shouldn't cascade — each row is its own tx
//   * the worker is single-instance on Render free; concurrency comes
//     from running multiple workers later, not parallel-batching here

const SELECT_ONE_FOR_UPDATE_SQL = `
  UPDATE "Notification"
     SET state = 'sending'
   WHERE id = (
       SELECT id FROM "Notification"
        WHERE state = 'queued'
          AND channel = 'email'
          AND ("scheduledFor" IS NULL OR "scheduledFor" <= now())
        ORDER BY "createdAt" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
   )
   RETURNING id, "userId", subject, body
`;

interface ClaimedRow {
  id: string;
  userId: string;
  subject: string;
  body: string;
}

interface UserRow {
  email: string;
}

export async function dispatch(ctx: Context, maxPerTick: number): Promise<number> {
  let dispatched = 0;
  for (let i = 0; i < maxPerTick; i++) {
    const claimed = await claim(ctx);
    if (!claimed) break;

    const user = await ctx.prisma.user.findUnique({
      where: { id: claimed.userId },
      select: { email: true },
    });

    if (!user || !user.email) {
      // The user was deleted between enqueue and dispatch. Mark failed
      // (terminal) so we don't keep retrying.
      await markFailed(ctx, claimed.id, 'no-recipient');
      dispatched += 1;
      continue;
    }

    const sendResult = await sendEmail(ctx, claimed, user);
    if (sendResult.ok) {
      await markDelivered(ctx, claimed.id);
    } else {
      await markFailed(ctx, claimed.id, sendResult.reason);
    }
    dispatched += 1;
  }
  return dispatched;
}

async function claim(ctx: Context): Promise<ClaimedRow | null> {
  // ``FOR UPDATE SKIP LOCKED`` makes the claim safe under concurrent
  // workers (a future deployment can scale horizontally without a
  // separate scheduler). Prisma's $queryRawUnsafe returns the
  // RETURNING columns as a row array.
  const rows = await ctx.prisma.$queryRawUnsafe<ClaimedRow[]>(SELECT_ONE_FOR_UPDATE_SQL);
  return rows[0] || null;
}

async function markDelivered(ctx: Context, id: string): Promise<void> {
  await ctx.prisma.notification.update({
    where: { id },
    data: { state: 'delivered', deliveredAt: new Date() },
  });
}

async function markFailed(ctx: Context, id: string, reason: string): Promise<void> {
  console.warn(`notification-worker.failed id=${id} reason=${reason}`);
  await ctx.prisma.notification.update({
    where: { id },
    data: { state: 'failed' },
  });
}

interface SendResult {
  ok: boolean;
  reason: string;
}

async function sendEmail(
  ctx: Context,
  notification: ClaimedRow,
  user: UserRow,
): Promise<SendResult> {
  if (!ctx.resend) {
    // Dryrun mode — Resend not configured. Mark as delivered and log so
    // dev environments still progress notifications through the state
    // machine without dropping them.
    console.log(
      `notification-worker.dryrun to=${user.email} subject="${notification.subject}"`,
    );
    return { ok: true, reason: 'dryrun' };
  }

  try {
    const res = await ctx.resend.emails.send({
      from: ctx.from,
      to: user.email,
      subject: notification.subject,
      text: notification.body,
    });
    if (res.error) {
      return { ok: false, reason: `resend:${res.error.name}` };
    }
    return { ok: true, reason: 'sent' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `exception:${message.slice(0, 80)}` };
  }
}
