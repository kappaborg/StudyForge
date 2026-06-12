import { describe, expect, it, vi } from 'vitest';
import { dispatch } from './dispatcher.js';
import type { Context } from './context.js';

// Fake Prisma + Resend that captures the dispatcher's interactions
// without standing up a database. Each test seeds the fake with a
// scenario, runs ``dispatch``, asserts the final state.

interface FakeNotification {
  id: string;
  userId: string;
  subject: string;
  body: string;
  state: string;
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
      const next = notifications.find((n) => n.state === 'queued');
      if (!next) return [];
      next.state = 'sending';
      return [{ id: next.id, userId: next.userId, subject: next.subject, body: next.body }];
    }),
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        return opts.users.find((u) => u.id === where.id) ?? null;
      }),
    },
    notification: {
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = notifications.find((n) => n.id === where.id);
        if (row && typeof data.state === 'string') row.state = data.state;
        return row;
      }),
    },
  };

  const resend = opts.resendError || opts.resendThrows
    ? {
        emails: {
          send: vi.fn(async (payload: { to: string; subject: string }) => {
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

describe('dispatcher.dispatch', () => {
  it('delivers a queued email to the recipient and marks delivered', async () => {
    const { ctx, emailsSent } = buildFakeCtx({
      notifications: [
        { id: 'n1', userId: 'u1', subject: 'Quiz due', body: 'Body', state: 'queued' },
      ],
      users: [{ id: 'u1', email: 'student@example.com' }],
    });

    const count = await dispatch(ctx, 10);
    expect(count).toBe(1);
    expect(emailsSent).toEqual([{ to: 'student@example.com', subject: 'Quiz due' }]);
  });

  it('returns 0 when no queued rows are available', async () => {
    const { ctx } = buildFakeCtx({
      notifications: [],
      users: [],
    });
    expect(await dispatch(ctx, 10)).toBe(0);
  });

  it('marks failed when the recipient was deleted', async () => {
    const notifications: FakeNotification[] = [
      { id: 'n1', userId: 'gone', subject: 'Quiz due', body: '', state: 'queued' },
    ];
    const { ctx } = buildFakeCtx({ notifications, users: [] });
    const count = await dispatch(ctx, 10);
    expect(count).toBe(1);
    expect(notifications[0]?.state).toBe('failed');
  });

  it('marks failed when Resend returns an error', async () => {
    const notifications: FakeNotification[] = [
      { id: 'n1', userId: 'u1', subject: 'Quiz due', body: '', state: 'queued' },
    ];
    const { ctx } = buildFakeCtx({
      notifications,
      users: [{ id: 'u1', email: 'a@b.com', }],
      resendError: 'invalid_email',
    });
    const count = await dispatch(ctx, 10);
    expect(count).toBe(1);
    expect(notifications[0]?.state).toBe('failed');
  });

  it('marks failed when Resend throws', async () => {
    const notifications: FakeNotification[] = [
      { id: 'n1', userId: 'u1', subject: 'Q', body: '', state: 'queued' },
    ];
    const { ctx } = buildFakeCtx({
      notifications,
      users: [{ id: 'u1', email: 'a@b.com', }],
      resendThrows: true,
    });
    await dispatch(ctx, 10);
    expect(notifications[0]?.state).toBe('failed');
  });

  it('drains up to maxPerTick rows in a single call', async () => {
    const { ctx, emailsSent } = buildFakeCtx({
      notifications: Array.from({ length: 5 }, (_, i) => ({
        id: `n${i}`,
        userId: 'u1',
        subject: `s${i}`,
        body: '',
        state: 'queued',
      })),
      users: [{ id: 'u1', email: 'student@example.com', }],
    });
    const count = await dispatch(ctx, 3);
    expect(count).toBe(3);
    expect(emailsSent).toHaveLength(3);
  });

  it('dryrun mode (resend=null) still marks delivered without erroring', async () => {
    const notifications: FakeNotification[] = [
      { id: 'n1', userId: 'u1', subject: 'Q', body: '', state: 'queued' },
    ];
    const { ctx } = buildFakeCtx({
      notifications,
      users: [{ id: 'u1', email: 'a@b.com', }],
    });
    // Override resend to null
    const dryCtx: Context = { ...ctx, resend: null };
    const count = await dispatch(dryCtx, 10);
    expect(count).toBe(1);
    expect(notifications[0]?.state).toBe('delivered');
  });
});
