import http from 'node:http';
import { dispatch } from './dispatcher.js';
import { buildContext, type Context } from './context.js';

// Polls the Notification table every TICK_MS for ``state='queued'``
// email rows that are due (``scheduledFor <= now()``), dispatches them
// via Resend, and updates state. Push + in_app channels are out of
// scope for v1 — in_app is delivered synchronously by the API service.

const TICK_MS = Number(process.env.NOTIFICATION_TICK_MS || 30_000);
const MAX_PER_TICK = Number(process.env.NOTIFICATION_MAX_PER_TICK || 25);
const PORT = Number(process.env.PORT || 8002);

async function tick(ctx: Context): Promise<void> {
  try {
    const dispatched = await dispatch(ctx, MAX_PER_TICK);
    if (dispatched > 0) {
      console.log(`notification-worker.tick dispatched=${dispatched}`);
    }
  } catch (err) {
    console.error('notification-worker.tick error', err);
  }
}

async function main(): Promise<void> {
  const ctx = await buildContext();
  console.log(
    `notification-worker.boot resend=${ctx.resend ? 'configured' : 'dryrun'} ` +
      `from="${ctx.from}" tick=${TICK_MS}ms`,
  );

  // Tiny HTTP surface so Render (or any process supervisor) has
  // something to probe for liveness — Render's free web-service tier
  // kills processes without an open port.
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: 'notification-worker' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(PORT, () => {
    console.log(`notification-worker.http port=${PORT}`);
  });

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    console.log('notification-worker.shutdown');
    server.close();
    await ctx.prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  // First tick immediately so a queued email isn't waiting 30s on cold start.
  await tick(ctx);
  setInterval(() => {
    void tick(ctx);
  }, TICK_MS);
}

main().catch((err) => {
  console.error('notification-worker.fatal', err);
  process.exit(1);
});
