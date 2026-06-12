# notification-worker

Polls the `Notification` table for queued email rows and dispatches
them via Resend. Push + in_app channels are out of scope here — in_app
delivers synchronously from the API, push lands in Phase 3.

## What it does

Every `NOTIFICATION_TICK_MS` (default 30000):

1. Atomically claim one row where `state='queued'`, `channel='email'`,
   `scheduledFor IS NULL OR scheduledFor <= now()`, ordered by
   `createdAt ASC`. Postgres `FOR UPDATE SKIP LOCKED` makes this safe
   under multiple worker instances.
2. Look up the recipient. If the user was deleted between enqueue and
   dispatch, mark `failed` (terminal — v1 has no retry counter).
3. Call Resend with `from`, `to`, `subject`, `text`. Success →
   `state='delivered'`, `deliveredAt=now()`. Resend error or thrown
   exception → `state='failed'`.
4. Loop up to `NOTIFICATION_MAX_PER_TICK` (default 25) before sleeping.

When `RESEND_API_KEY` is unset, the worker runs in **dryrun mode**:
notifications progress to `delivered` and are logged but no email is
actually sent. This is the dev + CI behaviour.

## Run

```bash
pnpm --filter notification-worker dev   # tsx watch, default port 8002
pnpm --filter notification-worker build && pnpm --filter notification-worker start
```

## Env

| Variable | Default | Notes |
| --- | --- | --- |
| `DATABASE_URL` | — | Required. Same DSN as the API (Prisma client is regenerated from `../api/prisma/schema.prisma`). |
| `RESEND_API_KEY` | unset | When unset, dryrun mode — emails are logged not sent. |
| `EMAIL_FROM` | `StudyForge <onboarding@resend.dev>` | Verify a real domain in Resend before sending to non-account-owner addresses. |
| `NOTIFICATION_TICK_MS` | `30000` | Poll cadence. |
| `NOTIFICATION_MAX_PER_TICK` | `25` | Backlog drain cap per tick. |
| `PORT` | `8002` | HTTP `/health` endpoint for Render liveness. |

## Test

```bash
pnpm --filter notification-worker test
```

Tests use a fake Prisma + Resend pair — no database, no live API call.

## Production

The Render service is `studyforge-notification-worker`. Same Docker
build pattern as the API. Free tier sleeps after 15 min — wake the
service with a periodic `/health` ping or accept ~30s delay on cold
notification delivery.

## Open

- [ ] Persistent retry counter — v1 marks `failed` on first error.
- [ ] Web push (VAPID) — Phase 3.
- [ ] MJML templates + i18n bundles — Phase 4.
- [ ] PostHog delivery telemetry.
