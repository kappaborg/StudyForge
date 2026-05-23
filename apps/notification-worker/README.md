# notification-worker

Transactional + scheduled outbound communications.

**Implementation target:** Phase 2 (Wk 6–8).

## Channels

- Transactional email (Resend or Postmark)
- Web push (VAPID)
- In-app inbox (writes to `Notification` table; FE polls / subscribes via WS)
- Daily / weekly digests (composed by Notification Agent, sent through above)

## Responsibilities

- Consume `notification.*` BullMQ jobs
- Render templates (MJML for email)
- Honour per-user quiet hours and locale
- Retry with exponential backoff; DLQ after 5 attempts
- Emit delivery telemetry to PostHog

## Tasks (open)

- [ ] Template registry + i18n bundles
- [ ] Quiet-hours policy engine
- [ ] Provider abstraction (Resend / Postmark / SES)
