# Deliverable 10 — Cross-Cutting Systems

**Status:** Draft v0.1
**Owner:** Platform
**Last updated:** 2026-05-21
**Implements:** [`prompt.md`](../../prompt.md) §10
**Source of truth:** [`apps/ai-worker/src/cost`](../../apps/ai-worker/src/cost) · [`apps/ai-worker/src/notifications`](../../apps/ai-worker/src/notifications) · [`apps/ai-worker/src/versioning`](../../apps/ai-worker/src/versioning) · [`apps/api/src/lti`](../../apps/api/src/lti)

---

## (a) Design rationale

This deliverable covers eight systems that touch every feature: notifications, billing, cost guardrails, feature flags, LMS integration, full-text search, product analytics, and artifact versioning. They share a pattern: **a thin domain layer that other features consume, backed by a swappable adapter to a third-party service**. We never let third-party SDKs leak into business logic; the swap from Postmark → Resend, Unleash → Flagsmith, Stripe → other should be confined to one adapter file each.

Three principles thread through every system:

1. **Limits are graceful, not abrupt.** Free-tier exhaustion downshifts the model, it never returns 429 to a student. Notifications honour quiet hours instead of dropping. Feature flags roll out by percentage with a kill switch — they don't flip globally and break tenants. Stripe dunning warns at 80% before billing fails.
2. **Every consumer goes through a typed contract.** Tier policy is YAML loaded into a Pydantic model; LTI claims are a Pydantic model; notification payloads are a Pydantic model. No string-keyed dictionaries cross the boundary.
3. **Cost telemetry is universal.** Every LLM call writes a `UsageEvent`. The budget evaluator reads aggregated counts from `TokenBudget`. The billing-worker reads `UsageEvent` to produce Stripe metered usage. Same source, three consumers — no separate counters that drift.

The Phase 0 implementation in this commit:

- Implements a **tier policy engine** that loads the YAML from §13.9 of `prompt.md`, validates it via Pydantic, and evaluates per-tenant budget consumption against the policy.
- Implements a **budget evaluator** that returns `allow` / `downshift` / `rate_limit` / `block` with the next-allowed-model recommendation; consumed by the LLM router.
- Implements **quiet-hours evaluation** for the notification system — timezone-aware, locale-aware, deterministic.
- Implements the **LTI 1.3 launch validator** (OIDC initiation + `id_token` claim + signature verification against the issuer's JWKS).
- Implements the **artifact-diff helper** so the regeneration workflow can show students what changed when a course's documents are re-uploaded.

The remaining systems — Stripe webhook receiver, Meilisearch indexer, PostHog event schema, full feature-flag rollout machinery, full email rendering — are documented here and ship in Phase 2–4.

---

## (b) System designs

### B.1 Notifications

A notification flows: **agent → queue → worker → channel adapter → user**. Channels (email, web push, in-app inbox, digest aggregator) are interchangeable adapters; the queue is BullMQ.

| Concern | Decision |
|---|---|
| Transactional email | Resend (primary) with Postmark fallback. Adapter interface in `apps/notification-worker/adapters/email.ts`. |
| Web push | VAPID; subscription stored on `User.webPushSubscription` JSON; sender in the notification worker. |
| In-app inbox | Writes to the `Notification` table; FE polls every 60 s and subscribes via WS when the workspace is open. |
| Digests | Composed by the Notification Agent (§5); scheduled rows in `Notification` with `scheduledFor`. |
| Quiet hours | Per-user `User.preferences.quietHours = { start: "22:00", end: "07:00", timezone: "Europe/Istanbul" }`. The worker delays scheduled rows whose `scheduledFor` falls inside the window. |
| Locale | Templates resolved by `User.locale`; ICU plural rules; per-locale message bundles. |
| Retry | Exponential backoff (1m → 1h, factor 4, max 5 attempts); DLQ on exhaustion. |

The **quiet hours evaluator** is implemented in this commit (`apps/ai-worker/src/notifications/quiet_hours.py`). It folds a UTC `scheduledFor` into the user's local time, checks against the window (including the cross-midnight case), and returns either `send_now` or the next-allowed UTC time.

### B.2 Billing

A subscription has three layers: Stripe (the source of truth for status + payment), the `Subscription` table (denormalised for fast reads), and `UsageEvent` (per-call cost ledger). The **billing-worker** subscribes to Stripe webhooks and writes to `Subscription`; it reads `UsageEvent` daily to push metered usage records back to Stripe.

| Tier | Daily tokens | Monthly tokens | Providers | On exhaust | Billing party |
|---|---|---|---|---|---|
| `free` | 200 000 | 3 000 000 | groq · gemini_free · openrouter_free · hf_inference · webllm | downshift | platform |
| `pro` | 5 000 000 | unlimited | + paid providers | rate_limit | user |
| `byok` | unlimited | unlimited | user_keys | n/a | user |
| `institutional` | unlimited | unlimited | all | n/a | institution |

The tier matrix lives in `infra/tiers/policy.yaml` (committed). The **tier policy engine** (`apps/ai-worker/src/cost/tier_policy.py`) loads it once at boot, validates via Pydantic, and exposes `evaluate(tenant_id, est_tokens, current_usage)` → `BudgetDecision`.

Stripe specifics:

- **Idempotent on `event.id`**: webhook handler writes a `BillingEventReceipt` row keyed on the event id before processing; replays are no-ops.
- **Signature verified** by Stripe SDK using `STRIPE_WEBHOOK_SECRET`.
- **Dunning**: at 80% of monthly cap, soft warn notification; at 100%, model downshift (free) or rate limit (pro). Past-due subscriptions follow Stripe's smart-retry schedule plus three reminder emails over 14 days, after which the subscription drops to `free`.
- **Invoice export**: instructor / admin role can pull `GET /v1/billing/invoices/{id}.pdf` (Stripe-hosted, signed URL).

### B.3 Cost guardrails

The **budget evaluator** is the single funnel between an agent's intent to call a provider and the actual call. It is the runtime mechanism behind the §13.9 tier policy.

Returns one of:

| Decision | When | Effect |
|---|---|---|
| `allow` | usage well under cap | Continue with the requested model |
| `warn` | usage between 80 % and 100 % daily | Continue + emit `billing_warning` notification |
| `downshift` | over daily cap, `on_exhaust=downshift` | Continue with the cheapest provider in the tier's free list |
| `rate_limit` | over daily cap, `on_exhaust=rate_limit` | Return `429` (paid tiers) |
| `block` | over monthly cap, `on_exhaust=block` | Refuse the call |

A free-tier student is **never** blocked — by construction. `BlockDecision` is reachable only for paid tiers with explicit billing setup; the engine raises a typed error if `free` is paired with `block`.

### B.4 Feature flags

Unleash is the chosen tool. The wrapper in `packages/feature-flags` exposes `isEnabled(name, ctx)` and `variant(name, ctx)` where `ctx = { tenantId, userId, tier, environment }`. Rules are stored in Unleash, not in code; flags are evaluated locally with a 30-second refresh from the Unleash server. Stale evaluations are safe — every flag has a documented "off" behaviour that is acceptable indefinitely.

**Naming convention**: `area.feature.policy`, e.g. `rag.kg-expand`, `webllm.tutor.simple`, `byok.add`. Names are immutable once shipped; removing a flag means deleting the call site.

**Rollout pattern**: `enabled: false` → `enabled: true, rules: { percentage: 5 }` → `25 %` → `100 %` → flag removed. Each step ships with the next-step PR queued.

### B.5 LMS integration (LTI 1.3)

Two endpoints carry the launch:

1. `POST /v1/lti/login_initiation` — OIDC third-party login initiation. Validates `iss`, `target_link_uri`, and returns a redirect to the platform with state + nonce.
2. `POST /v1/lti/auth` — receives the `id_token` JWS, verifies signature against the issuer's JWKS (cached with TTL), validates `iss`, `aud`, `azp`, `nonce`, `iat`, `exp`, and the `https://purl.imsglobal.org/spec/lti/claim/deployment_id` claim, then provisions or matches `(User, Course)` for the deployment.

The validator in `apps/api/src/lti/launch.ts` is implemented in this commit with real JWT signature verification (RS256/ES256). AGS (grade passback) and NRPS (roster sync) reuse the resolved deployment_id from the launch — those services land in Phase 4.

### B.6 Search

Meilisearch is the exact-string + lexical search layer that complements the dense RAG retriever. It indexes:

- `Chunk.content` (lexical, BM25)
- `Document.originalFilename`
- `Concept.label`
- `Course.title` and `Course.code`

Documents are pushed to Meilisearch by the ingest worker after embedding; deletes propagate via the soft-delete trigger that bumps `concept_graph_generation`. Per-tenant isolation is enforced by Meilisearch's API key scoping — one search key per tenant, signed JWT-style.

Search endpoint: `GET /v1/search?q=…&courseId=…` (Deliverable 4). Returns a `SearchHit[]` with chunk id, score, snippet, and document metadata. No semantic retrieval here — `/v1/chat/sessions/{id}/messages` is the path for grounded Q&A.

### B.7 Analytics

PostHog hosts product analytics. The event schema lives in `apps/web/lib/analytics.ts` as a typed enum so misspellings fail at typecheck time. Every event carries `tenant_id`, `tier`, `provider_id` (when LLM-related), `cost_micro_usd` (when LLM-related), and the route segment.

| Event group | Examples | Purpose |
|---|---|---|
| Activation | `signup.complete`, `upload.first` | Funnel + cohort retention |
| Workspace | `tutor.message.sent`, `quiz.attempt.submitted`, `flashcard.reviewed` | Engagement |
| Cost | `model.routed`, `cache.hit`, `byok.used` | Cost-per-MAU dashboard |
| Quality | `tutor.refused`, `quiz.regenerated` | Pipeline-quality regressions |

Instructor-facing **cohort BI** anonymises and aggregates the same events at the course level — no per-student identifier ever leaves a tenant boundary.

### B.8 Artifact versioning

Generated artifacts (quizzes, flashcards, roadmaps, concept graphs) are tied to one or more `DocumentVersion` ids. When a course's documents are re-uploaded:

1. Ingest writes a new `DocumentVersion` row (with `contentSha256`).
2. The orchestrator enqueues a `regenerate.course` job carrying the affected document ids.
3. Affected agents (Semantic Analyzer, Curriculum Builder, Quiz Generator, Flashcard Generator, Roadmap Planner) re-run.
4. Their outputs are written as new artifact rows; the old rows are soft-deleted but retained for diff.
5. The **artifact diff** (in this commit) compares old vs new and surfaces a UI summary: "+ 3 new flashcards, − 1 removed, ~ 2 changed."

This is what makes regeneration safe — a student can see *exactly* what their generated material looks like after the upload, instead of an undifferentiated "we re-generated everything" message.

---

## (c) Trade-offs explicitly rejected

| Rejected | Reason |
|---|---|
| **Polling Stripe for subscription state** | Stripe webhooks are the source of truth. Polling adds latency and rate-limit risk. |
| **Sending notifications to free-tier exhausted users** | Already in a degraded state; piling on with email is bad UX. Quota notifications go through the in-app inbox only. |
| **Storing the LTI JWKS in our database** | Stale keys break launches silently. We fetch and cache with a TTL (10 min default) and revalidate on signature failure. |
| **Custom feature-flag service** | Unleash gives us tenant / user / percentage targeting + an audit trail for free. Building our own is a perpetual fix-the-flags problem. |
| **Meilisearch as a replacement for the RAG retriever** | Exact-string and dense-semantic are complementary, not redundant. We expose both; agents use the RAG retriever, the workspace search bar uses Meilisearch. |
| **Anonymous PostHog usage** | Per-user telemetry is needed for the cohort BI surfaces. We keep PostHog inside the tenant boundary and never send across regions. |
| **Hard-block on free-tier exhaustion** | Breaks the "free by default" principle. Downshift to the cheapest provider; never return 429 to a free student. |
| **One mega tier-policy YAML for all environments** | Diff hostile. Tier policy is one YAML per environment; the CI loader validates that production has no `block` on `free`. |
| **Letting agents read flags directly from Unleash** | Drift between server-side and client-side flag evaluations. All flag reads go through `packages/feature-flags` so both sides see the same logic. |
| **Mutable feature-flag names** | Renaming a flag invalidates analytics history. Names are immutable; deletion removes the call site. |
| **Combined Stripe + LTI billing model** | Universities require institution-paid billing with no per-student credit card; Stripe Connect was tempting but adds operational complexity we don't need at this scale. Institutional billing goes through standard invoice; Stripe is for individual Pro subscribers. |

---

## Next deliverables

- [Deliverable 11 — DevOps & Delivery](./11-devops-delivery.md) — Helm charts, signed images, CI gates including this deliverable's CI checks.
- [Deliverable 13 — Cost & Access](./13-cost-and-access.md) — uses the tier policy + budget evaluator implemented here.
