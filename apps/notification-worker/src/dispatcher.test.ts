import { describe, expect, it, vi } from 'vitest';
import { dispatch } from './dispatcher.js';
import type { Context } from './context.js';

// Fake Prisma + Resend that captures the dispatcher's interactions
// without standing up a database. Each test seeds the fake with a
// scenario, runs ``dispatch``, asserts the final state. The fake
// tracks the retry-loop fields too so we can prove the backoff +
// terminal-on-budget-spent behaviour.

interface FakeNotification {
  id: string;
  userId: string;
  subject: string;
  body: string;
  state: string;
  retryCount: number;
  scheduledFor: Date | null;
  lastErrorReason: string | null;
}

interface FakeUser {
  id: string;
  email: string | null;
}

function buildFakeCtx(opts: {
  notifications: FakeNotification[];
  users: FakeUser[];
  resendError?: string;
  resendThrows?: boolean;
}): { ctx: Context; emailsSent: Array<{ to: string; subject: string }> } {
  const notifications = [...opts.notifications];
  const emailsSent: Array<{ to: string; subject: string }> = [];

  const prisma = {
    $queryRawUnsafe: vi.fn(async () => {
      // Mirror the SQL claim semantics:
      //   state='queued' AND channel='email' AND
      //   (scheduledFor IS NULL OR scheduledFor <= now())
      // Ordered by createdAt — preserved by insertion order here.
      const now = new Date();
      const next = notifications.find(
        (n) =>
          n.state === 'queued' &&
          (n.scheduledFor === null || n.scheduledFor <= now),
      );
      if (!next) return [];
      next.state = 'sending';
      return [
        {
          id: next.id,
          userId: next.userId,
          subject: next.subject,
          body: next.body,
          retryCount: next.retryCount,
        },
      ];
    }),
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        return opts.users.find((u) => u.id === where.id) ?? null;
      }),
    },
    notification: {
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => {
          const row = notifications.find((n) => n.id === where.id);
          if (!row) return null;
          if (typeof data.state === 'string') row.state = data.state;
          if (typeof data.retryCount === 'number') row.retryCount = data.retryCount;
          if (data.scheduledFor instanceof Date) row.scheduledFor = data.scheduledFor;
          if (data.scheduledFor === null) row.scheduledFor = null;
          if (typeof data.lastErrorReason === 'string') {
            row.lastErrorReason = data.lastErrorReason;
          }
          return row;
        },
      ),
    },
  };

  const resend =
    opts.resendError || opts.resendThrows
      ? {
          emails: {
            send: vi.fn(async (_payload: { to: string; subject: string }) => {
              if (opts.resendThrows) throw new Error('upstream 500');
              return { error: { name: opts.resendError } };
            }),
          },
        }
      : {
          emails: {
            send: vi.fn(async (payload: { to: string; subject: string }) => {
              emailsSent.push({ to: payload.to, subject: payload.subject });
              return { error: null };
            }),
          },
        };

  return {
    ctx: {
      prisma: prisma as unknown as Context['prisma'],
      resend: resend as unknown as Context['resend'],
      from: 'StudyForge <test@example.com>',
    },
    emailsSent,
  };
}

function makeNotification(overrides: Partial<FakeNotification> = {}): FakeNotification {
  return {
    id: 'n1',
    userId: 'u1',
    subject: 'Quiz due',
    body: 'Body',
    state: 'queued',
    retryCount: 0,
    scheduledFor: null,
    lastErrorReason: null,
    ...overrides,
  };
}

describe('dispatcher.dispatch — happy path + permanent failures', () => {
  it('delivers a queued email to the recipient and marks delivered', async () => {
    const { ctx, emailsSent } = buildFakeCtx({
      notifications: [makeNotification({ subject: 'Quiz due' })],
      users: [{ id: 'u1', email: 'student@example.com' }],
    });

    const count = await dispatch(ctx, 10);
    expect(count).toBe(1);
    expect(emailsSent).toEqual([{ to: 'student@example.com', subject: 'Quiz due' }]);
  });

  it('returns 0 when no queued rows are available', async () => {
    const { ctx } = buildFakeCtx({ notifications: [], users: [] });
    expect(await dispatch(ctx, 10)).toBe(0);
  });

  it('marks failed (terminal) when the recipient was deleted', async () => {
    const notifications = [makeNotification({ userId: 'gone' })];
    const { ctx } = buildFakeCtx({ notifications, users: [] });
    const count = await dispatch(ctx, 10);
    expect(count).toBe(1);
    expect(notifications[0]?.state).toBe('failed');
    expect(notifications[0]?.lastErrorReason).toBe('no-recipient');
    expect(notifications[0]?.retryCount).toBe(0); // not retried — permanent
  });

  it('marks failed (terminal) on permanent Resend errors without retrying', async () => {
    // ``invalid_email`` is in PERMANENT_FAILURE_PREFIXES — no retry.
    const notifications = [makeNotification()];
    const { ctx } = buildFakeCtx({
      notifications,
      users: [{ id: 'u1', email: 'bad@@example.com' }],
      resendError: 'invalid_email',
    });
    await dispatch(ctx, 10);
    expect(notifications[0]?.state).toBe('failed');
    expect(notifications[0]?.retryCount).toBe(0);
    expect(notifications[0]?.lastErrorReason).toContain('invalid_email');
  });

  it('drains up to maxPerTick rows in a single call', async () => {
    const { ctx, emailsSent } = buildFakeCtx({
      notifications: Array.from({ length: 5 }, (_, i) =>
        makeNotification({ id: `n${i}`, subject: `s${i}` }),
      ),
      users: [{ id: 'u1', email: 'student@example.com' }],
    });
    const count = await dispatch(ctx, 3);
    expect(count).toBe(3);
    expect(emailsSent).toHaveLength(3);
  });

  it('dryrun mode (resend=null) still marks delivered without erroring', async () => {
    const notifications = [makeNotification()];
    const { ctx } = buildFakeCtx({
      notifications,
      users: [{ id: 'u1', email: 'a@b.com' }],
    });
    const dryCtx: Context = { ...ctx, resend: null };
    const count = await dispatch(dryCtx, 10);
    expect(count).toBe(1);
    expect(notifications[0]?.state).toBe('delivered');
  });
});

describe('dispatcher.dispatch — transient failures + exponential backoff', () => {
  it('re-queues with backoff after a thrown exception (transient)', async () => {
    const notifications = [makeNotification()];
    const { ctx } = buildFakeCtx({
      notifications,
      users: [{ id: 'u1', email: 'a@b.com' }],
      resendThrows: true,
    });
    const t0 = Date.now();
    await dispatch(ctx, 10);

    // After the failure: row should be back in ``queued`` with a future
    // ``scheduledFor`` and a bumped retryCount. Critically NOT terminal.
    expect(notifications[0]?.state).toBe('queued');
    expect(notifications[0]?.retryCount).toBe(1);
    expect(notifications[0]?.scheduledFor).toBeInstanceOf(Date);
    expect(notifications[0]?.scheduledFor!.getTime()).toBeGreaterThanOrEqual(
      t0 + 60_000 - 100,
    ); // ~1 minute first-retry delay
    expect(notifications[0]?.lastErrorReason).toContain('exception');
  });

  it('re-queues with backoff on a transient resend error (unknown name)', async () => {
    // An unknown Resend error name isn't in PERMANENT_FAILURE_PREFIXES,
    // so it should be treated as transient.
    const notifications = [makeNotification()];
    const { ctx } = buildFakeCtx({
      notifications,
      users: [{ id: 'u1', email: 'a@b.com' }],
      resendError: 'upstream_timeout',
    });
    await dispatch(ctx, 10);
    expect(notifications[0]?.state).toBe('queued');
    expect(notifications[0]?.retryCount).toBe(1);
  });

  it('does not pick up a re-queued row in the same tick (future scheduledFor)', async () => {
    // After failure → scheduledFor is +1m. The very next claim within
    // the same tick must skip this row, otherwise we'd burn the entire
    // retry budget in one tick.
    const notifications = [makeNotification()];
    const { ctx } = buildFakeCtx({
      notifications,
      users: [{ id: 'u1', email: 'a@b.com' }],
      resendThrows: true,
    });
    const dispatched = await dispatch(ctx, 10);
    expect(dispatched).toBe(1); // one failure handled
    expect(notifications[0]?.retryCount).toBe(1); // not 5
  });

  it('escalates retryCount each transient failure', async () => {
    // Simulate three consecutive transient failures by repeatedly
    // resetting scheduledFor to "now" between dispatch calls.
    const notifications = [makeNotification()];
    const { ctx } = buildFakeCtx({
      notifications,
      users: [{ id: 'u1', email: 'a@b.com' }],
      resendThrows: true,
    });

    for (let attempt = 1; attempt <= 3; attempt++) {
      // Pretend the retry window has elapsed.
      notifications[0]!.scheduledFor = new Date(Date.now() - 1000);
      await dispatch(ctx, 1);
      expect(notifications[0]?.retryCount).toBe(attempt);
      expect(notifications[0]?.state).toBe('queued');
    }
  });

  it('gives up after MAX_RETRIES transient failures', async () => {
    // Start the row already at the retry budget boundary (4): the next
    // failure tips it past MAX_RETRIES (5 by default) and goes terminal.
    const notifications = [makeNotification({ retryCount: 5 })];
    const { ctx } = buildFakeCtx({
      notifications,
      users: [{ id: 'u1', email: 'a@b.com' }],
      resendThrows: true,
    });
    await dispatch(ctx, 1);
    expect(notifications[0]?.state).toBe('failed');
    expect(notifications[0]?.retryCount).toBe(6); // monotonic — recorded the final attempt
  });

  it('eventually delivers after a transient failure clears', async () => {
    // First call throws → retry queued. Second call (after the window
    // has notionally elapsed) succeeds → delivered.
    const notifications = [makeNotification()];

    // Round 1: provider throws → queue retry.
    const throwingCtx = buildFakeCtx({
      notifications,
      users: [{ id: 'u1', email: 'a@b.com' }],
      resendThrows: true,
    });
    await dispatch(throwingCtx.ctx, 1);
    expect(notifications[0]?.state).toBe('queued');
    expect(notifications[0]?.retryCount).toBe(1);

    // Round 2: provider healthy, retry window has elapsed.
    notifications[0]!.scheduledFor = new Date(Date.now() - 1000);
    const goodCtx = buildFakeCtx({
      notifications,
      users: [{ id: 'u1', email: 'a@b.com' }],
    });
    await dispatch(goodCtx.ctx, 1);
    expect(notifications[0]?.state).toBe('delivered');
    expect(goodCtx.emailsSent).toHaveLength(1);
  });
});
