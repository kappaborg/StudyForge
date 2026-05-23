# Incident response

Use this when something is **on fire** in production — students can't
upload, the tutor returns 500s, or a security issue is suspected.

## Severity tiers

| Severity | Examples | Response |
|----------|----------|----------|
| **SEV-1** | Total outage, data loss risk, credential leak | Page on-call immediately, war-room open, public status page updated within 15 min |
| **SEV-2** | Major degradation (e.g. tutor refuses all queries), no data loss | Page on-call within 30 min, status page within 1 h |
| **SEV-3** | Partial degradation (e.g. flashcards slow), workaround exists | File issue, fix in next deploy |

## The five-minute drill

When alerts fire, the on-call does these five things, in order, before
escalating:

1. **Check Sentry** for the time window. Group similar errors; the top
   group is usually the culprit.
2. **Check the upstream provider dashboard.** Groq / OpenAI / etc.
   status page. ~40% of "our outages" are upstream.
3. **Check the platform LLM key's daily budget.** If it's exhausted,
   free-tier users hit the daily cap globally. Bump or rotate.
4. **Check `docker compose ps`** on the host. Was something OOM-killed?
5. **Check OTel traces** for the failing request. The trace shows
   which agent / DB query / upstream call is the actual bottleneck.

If none of these point at the cause, escalate to the next person on
the rotation and start a war-room thread.

## Common scenarios

### "All tutor queries refuse with 'I could not find this in your materials'"

- Embedder backend may have changed without a re-embed. Check
  `EMBEDDER_BACKEND` env. Run `POST /v1/admin/reembed` to backfill
  vectors.

### "Uploads succeed but generate 0 chunks"

- MIME on the upload was guessed wrong. Check `UploadBatch.mime` for
  recent rows; if many show `application/octet-stream`, the FE sent
  no `file.type` (typically because users dragged a file without an
  extension).

### "Daily budget exhausted notifications spiking"

- One BYOK key may have been revoked, dropping that tenant back to the
  free pool. Check `Tenant.tier` history vs `ApiKey.revokedAt`.
- Or a provider's free-tier daily quota refilled and we want to bump
  ours — open `apps/api/src/budget/budget.service.ts` and bump
  `FREE_DAILY_LIMIT` in a PR.

### "Suspected credential leak"

- Follow `SECURITY.md` — do **not** open a public issue.
- Immediately rotate the leaked key.
- For BYOK keys: a leak means a user's key got exposed via our logs.
  Audit the log redaction (`before_send` in observability.py/.ts) and
  ship a fix before announcing.

## After the incident

- Write a postmortem within 72 hours. Template:
  - Impact (users affected, duration, dollars / tokens burnt)
  - Timeline (alert → ack → mitigated → resolved)
  - Root cause (5-whys, no blame)
  - What we did well · what we did poorly · what we'll do differently
- Add a regression test or alert for the failure mode.
- Update this runbook with the new scenario.
