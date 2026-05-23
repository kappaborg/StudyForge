# Pre-launch checklist

Tick every box before the first public student lands on the site.
Boxes ticked separately for dev / staging / prod — staging is the
gate, prod is the public surface.

## Infra

- [ ] Postgres has nightly `pg_dump` to a separate volume / object store.
      Restore-from-backup tested at least once.
- [ ] MinIO data volume backed up (cron `mc mirror`).
- [ ] TLS cert wired (Let's Encrypt / Caddy / Cloudflare in front).
- [ ] Per-IP rate limit at the edge (Cloudflare or Nginx) — not just
      the in-app `Throttler`.
- [ ] Secrets are NOT in `.env` on the prod host. Use Doppler, AWS
      Secrets Manager, or sealed-secrets — anything that's not "file
      in the repo".

## Observability

- [ ] `SENTRY_DSN` set. Test event fired + visible in Sentry.
- [ ] `OTEL_EXPORTER_OTLP_ENDPOINT` set (Tempo or Grafana Cloud).
      Worker spans visible end-to-end.
- [ ] Status page wired (`status.studyforge.local`). Smoke check that
      a 500 surfaces a banner within 60s.
- [ ] On-call rotation table in `oncall.md` has at least the next 4
      weeks filled in.

## Application

- [ ] `make audit` clean (no critical findings).
- [ ] `make eval-tutor` returns exit code 0.
- [ ] `make e2e` returns exit code 0 (Playwright + axe).
- [ ] `pnpm typecheck && pnpm lint && pnpm test` all green.
- [ ] Real LLM keys configured for the platform pool (Groq + at least
      one fallback). Daily token budgets known.
- [ ] BYOK encryption KEK rotated from the dev default.
      `apps/api/src/security/envelope.ts` reads the real KEK from the
      secret manager.
- [ ] `Tenant.tier` defaults sane: every new tenant lands as
      `free` with the documented daily cap.

## Legal + trust

- [ ] OSS license set in `LICENSE` (MIT recommended).
- [ ] `SECURITY.md` published with a real reporting email.
- [ ] `/about` page reviewed for accuracy.
- [ ] Privacy stance documented somewhere user-facing ("we don't sell
      your data" lives in `/about`; expand to a full privacy page
      before EU launch).
- [ ] DSAR endpoint smoke-tested (export, erase).

## Communication

- [ ] Launch announcement drafted (where: HN, Reddit r/learnprogramming,
      a small university listserv).
- [ ] Welcome email template captures the "free forever, BYOK for
      unlimited, here's how to self-host" pitch in 3 sentences.
- [ ] On-call channel exists somewhere (Discord / Slack / Matrix).
- [ ] First-week monitoring plan — who's watching Sentry on day one,
      day three, day seven.

## Day-0 smoke test

Run on prod, in order, immediately after the DNS flip:

1. Open `/` — landing page renders, no console errors.
2. Open `/dashboard` (incognito) — dev-auth headers populate a fresh
       tenant.
3. Upload a small PDF — chunks indexed within 10s.
4. Ask the tutor a question on the PDF — cited answer streams in.
5. Generate flashcards + a quiz — both render.
6. Open `/about` — Sponsor link works.

If any of those fail in prod, **rollback** rather than patch in
place. The DNS TTL should be low (≤ 300s) for the first 48h.
