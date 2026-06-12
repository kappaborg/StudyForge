import type { Context } from './context.js';

// Pulls one email-channel notification at a time, atomically transitions
// it to ``sending``, looks up the recipient, calls Resend, and lands the
// row in:
//   * ``delivered`` on success
//   * ``queued`` again with ``scheduledFor`` set to an exponential-
//     backoff retry deadline on transient failure (Resend error, thrown
//     exception) until ``retryCount`` reaches MAX_RETRIES
//   * ``failed`` (terminal) on permanent failure (no recipient, bad
//     email) or after the retry budget is spent
//
// Caller (``main.ts``) loops up to ``maxPerTick`` before sleeping.
//
// We dispatch one-at-a-time intentionally:
//   * a slow Resend response shouldn't block the next one
//   * a transient failure shouldn't cascade — each row is its own tx
//   * the worker is single-instance on Render free; concurrency comes
//     from running multiple workers later, not parallel-batching here

// 1m → 5m → 30m → 2h → 12h. After 5 attempts (4 retries past the first)
// the row goes terminal. Matches the README's open-list expectation;
// real-world ops tunes this via two env vars.
const DEFAULT_BACKOFF_MS = [
  60_000, // 1m
  5 * 60_000, // 5m
  30 * 60_000, // 30m
  2 * 60 * 60_000, // 2h
  12 * 60 * 60_000, // 12h
];

const MAX_RETRIES = Number(process.env.NOTIFICATION_MAX_RETRIES || DEFAULT_BACKOFF_MS.length);

// Reasons that should NEVER retry — the failure mode is structural and
// no amount of waiting will fix it. Anything else is treated as
// transient up to the retry budget.
const PERMANENT_FAILURE_PREFIXES = [
  'no-recipient',
  'resend:invalid_email',
  'resend:invalid_to_address',
  'resend:validation_error',
  'resend:domain_not_verified',
  'resend:from_address_not_allowed',
];

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
   RETURNING id, "userId", subject, body, "retryCount"
`;

interface ClaimedRow {
  id: string;
  userId: string;
  subject: string;
  body: string;
  retryCount: number;
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
      // The user was deleted between enqueue and dispatch. ``no-recipient``
      // is a permanent failure — don't burn retry budget on it.
      await markPermanentlyFailed(ctx, claimed.id, 'no-recipient');
      dispatched += 1;
      continue;
    }

    const sendResult = await sendEmail(ctx, claimed, user);
    if (sendResult.ok) {
      await markDelivered(ctx, claimed.id);
    } else {
      await handleFailure(ctx, claimed, sendResult.reason);
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

async function markPermanentlyFailed(ctx: Context, id: string, reason: string): Promise<void> {
  console.warn(`notification-worker.failed.permanent id=${id} reason=${reason}`);
  await ctx.prisma.notification.update({
    where: { id },
    data: { state: 'failed', lastErrorReason: reason.slice(0, 240) },
  });
}

/**
 * Decide whether to give up or reschedule. The dispatcher claimed the
 * row by setting ``state='sending'``, so on retry we have to flip it
 * back to ``queued`` and stamp the next-attempt deadline into
 * ``scheduledFor`` — that field is also the claim predicate, so a
 * past-due ``scheduledFor`` is what makes the next tick pick the row
 * up. ``retryCount`` increments monotonically across attempts.
 */
async function handleFailure(
  ctx: Context,
  claimed: ClaimedRow,
  reason: string,
): Promise<void> {
  const reasonLower = reason.toLowerCase();
  const isPermanent = PERMANENT_FAILURE_PREFIXES.some((p) =>
    reasonLower.startsWith(p),
  );
  if (isPermanent) {
    await markPermanentlyFailed(ctx, claimed.id, reason);
    return;
  }

  const nextRetryCount = claimed.retryCount + 1;
  if (nextRetryCount > MAX_RETRIES) {
    console.warn(
      `notification-worker.failed.giveup id=${claimed.id} attempts=${nextRetryCount} reason=${reason}`,
    );
    await ctx.prisma.notification.update({
      where: { id: claimed.id },
      data: {
        state: 'failed',
        retryCount: nextRetryCount,
        lastErrorReason: reason.slice(0, 240),
      },
    });
    return;
  }

  // ``retryCount`` was 0 on first failure → use ``DEFAULT_BACKOFF_MS[0]``
  // (1m). On second failure (now retryCount=1) → 5m. And so on.
  const delayMs =
    DEFAULT_BACKOFF_MS[Math.min(claimed.retryCount, DEFAULT_BACKOFF_MS.length - 1)] ??
    DEFAULT_BACKOFF_MS[DEFAULT_BACKOFF_MS.length - 1]!;
  const nextAttempt = new Date(Date.now() + delayMs);

  console.log(
    `notification-worker.retry id=${claimed.id} attempt=${nextRetryCount}/${MAX_RETRIES} ` +
      `delay_ms=${delayMs} reason=${reason}`,
  );

  await ctx.prisma.notification.update({
    where: { id: claimed.id },
    data: {
      state: 'queued',
      scheduledFor: nextAttempt,
      retryCount: nextRetryCount,
      lastErrorReason: reason.slice(0, 240),
    },
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
