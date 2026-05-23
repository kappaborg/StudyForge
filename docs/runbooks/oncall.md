# On-call rotation

StudyForge is volunteer-maintained. The rotation is light by design —
you're not expected to drop life for a free product, but if you signed
up for the week, please answer pages within the SLA below.

## The rotation

- Single primary, no secondary
- Weekly handoff, Mondays 10:00 UTC
- Schedule lives at `docs/runbooks/oncall.md` (this file) — edit the
  table below in a PR when you swap.
- Skip a week? Trade with someone and update the table. Don't ghost.

| Week of | Primary | Notes |
|---------|---------|-------|
| 2026-W21 | _(unassigned)_ | Edit me |
| 2026-W22 | _(unassigned)_ | |
| 2026-W23 | _(unassigned)_ | |

## SLAs

| Severity | Ack | Mitigate |
|----------|-----|----------|
| SEV-1 | 30 min | 4 h |
| SEV-2 | 2 h | 24 h |
| SEV-3 | next business day | next release |

## Tools

- **Sentry** (errors) — link in `.env` under `SENTRY_DSN`
- **Status page** — `https://status.studyforge.local` (placeholder; wire
  a real one before launch)
- **Grafana / Tempo** (traces) — see `docker-compose.observability.yml`
  (Phase 5 add-on, opt-in)
- **DB console** — `make psql`

## Handoff checklist

When you swap on Monday:

1. **In-flight incidents** — anything open, even SEV-3, gets a one-line
   summary in `#oncall-handoff` (or whatever channel exists).
2. **Recent waivers** — any audit / lint / eval gate that the previous
   on-call manually overrode, with a reopen date.
3. **Known issues** — a glance at `SECURITY.md` "Known issues" + open
   GitHub issues tagged `oncall`.
4. **Quotas** — the platform LLM key's monthly usage and rotation date.

The outgoing on-call signs off by saying "you have the conn." That's
the handoff cue.
