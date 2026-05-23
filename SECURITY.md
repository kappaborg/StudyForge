# Security Policy

StudyForge is free, open source, and used by students. Vulnerability
reports help us keep them safe.

## Reporting a vulnerability

Email **security@studyforge.local** (or use GitHub's *Report a
vulnerability* button on the repo). **Do not** open a public issue.

We aim to:

- **Acknowledge** within 48 hours
- **Triage + initial assessment** within 5 business days
- **Patch** critical issues within 7 days, high within 14, medium within
  30. Public disclosure follows the patch by 7 days unless coordinated
  otherwise.

## What's in scope

- The web app (`apps/web`) — XSS, auth bypass, IDOR, prompt-injection
  surfaces
- The API (`apps/api`) — authz failures, SQL injection, SSRF, file
  upload abuse, BYOK key leakage
- The worker (`apps/ai-worker`) — model-output leaks, indirect prompt
  injection via uploaded materials
- Infra config in `infra/` and `docker-compose.yml` — exposed ports,
  default creds, IAM
- Supply-chain — `package.json`, `pyproject.toml`, `Dockerfile` deps

## Out of scope

- Self-hosted deployments where the operator misconfigured `.env`
  (e.g. shipped the default `studyforge-dev-secret` to production)
- Rate-limit bypass by holding many BYOK keys — that's working as
  intended
- Findings against `apps/web/.next` build output — report the source

## How we hunt today

- **Static** — Trivy filesystem scan, gitleaks for committed secrets,
  `pnpm audit --audit-level=high`, `pip-audit` on the worker venv. All
  four run in CI on every PR + nightly cron.
- **Dynamic** — axe-core a11y gate, Playwright e2e on the visible
  surface, per-tenant rate limits via Throttler (120 req/min default)
- **Defensive coding** — channel-separated prompt builder for the
  tutor, citation-enforcement refusal, AES-256-GCM envelope encryption
  for BYOK keys, RFC 9457 problem+json errors

## Known issues + planned fixes

Tracked here so they're visible without digging through CI runs. The
`make audit` target re-checks the current state.

- **Nest 10 → 11 + Fastify 4 → 5 migration** — clears the remaining
  high/critical advisories in `@nestjs/platform-fastify`, `fastify`,
  and `@fastify/middie`. Scheduled as a single focused PR; the API
  changes are limited to route decorator signatures.
- **`glob ≥ 10.5`** — transitive of `prisma`. Clears on the next Prisma
  bump.

CI gates on **critical** today and reports high/moderate without
blocking. Once the migration PR lands, the gate steps back up to
high.

## Hall of fame

Reporters who follow this policy get credit in the next release notes
(unless they request anonymity).
