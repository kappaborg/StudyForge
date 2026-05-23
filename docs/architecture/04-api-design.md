# Deliverable 4 — API Design

**Status:** Draft v0.1
**Owner:** Platform
**Last updated:** 2026-05-21
**Implements:** [`prompt.md`](../../prompt.md) §4
**Specs:** [`apps/api/openapi.yaml`](../../apps/api/openapi.yaml)

---

## (a) Design rationale

The API is the contract between every other system in StudyForge AI — the web app, the AI workers, the LMS connectors, the billing webhooks. Three principles drive every decision:

1. **One way to do every cross-cutting thing.** Errors are always `application/problem+json`. Lists always paginate by opaque cursor. Mutations always honour `Idempotency-Key`. Rate limits always surface as `RateLimit-*` headers. Auth is always Bearer JWT plus optional per-tenant scoping. This is non-negotiable; reviewers reject endpoints that diverge.
2. **REST for everything externally visible; tRPC only for the FE↔BE seam.** REST + OpenAPI 3.1 is what third-party developers, LMS vendors, and CLI scripts will consume. tRPC sits inside the web app for type-safe RSC ↔ NestJS calls where the schema is already shared via `packages/shared-types`. We do not expose a public GraphQL surface.
3. **Streams are SSE by default, WebSockets only when bidirectional.** LLM completions, pipeline progress, and notification delivery use Server-Sent Events — proxy-friendly, native reconnect, no framing layer. WebSockets are reserved for the tutor session, where the client sends tool-use confirmations and live cursors back upstream.

The rest of the document is the catalog of versioning, error format, pagination, idempotency, auth scopes, webhooks, streaming, and the endpoint table. The OpenAPI YAML is the machine-readable companion.

---

## (b) Conventions

### Versioning

- Path-prefixed: `/v1/*`. The current version is `v1`.
- `/health/*` and `/docs` are unversioned because they are operator-facing, not consumer-facing.
- A breaking change requires a new prefix (`/v2`). We commit to running `v1` for **18 months** after `v2` GA, returning `Deprecation` and `Sunset` headers per RFC 8594 the entire time.
- Non-breaking additions land in `v1` directly. The OpenAPI spec carries `x-introduced-in` per operation to make this discoverable.

### Authentication & authorisation

- **Public unauthenticated**: `/health/*`, `/v1/auth/*`, `/v1/lti/*`, `/v1/billing/stripe-webhook`, `/docs`.
- **Bearer JWT**: everything else. Access token TTL 15 min; refresh token (rotating) 30 d, `Secure HttpOnly SameSite=Strict` cookie.
- **Per-tenant scoping**: every authenticated request resolves a `tenantId` from the JWT. The request transaction starts with `SET LOCAL app.tenant_id = $1` so Postgres RLS enforces isolation even if controllers forget to filter.
- **CASL policy layer**: `student | instructor | admin | institution_admin`. Decorators (`@RequiresRole`, `@RequiresAbility`) on each controller method; missing decorator → fail closed at the guard layer in CI.
- **Service-to-service**: signed JWT with `aud: studyforge.internal` and short TTL; never the user's token.

### Error format — `application/problem+json` (RFC 9457)

```json
{
  "type": "https://studyforge.ai/errors/upload.size-exceeded",
  "title": "Upload size exceeds the platform limit",
  "status": 413,
  "detail": "Request would total 2.4 GB; limit is 2.0 GB for free-tier tenants.",
  "instance": "/v1/uploads/init",
  "traceId": "01HFXG9R…",
  "tenantId": "…",
  "code": "upload.size-exceeded",
  "fields": [
    { "name": "sizeBytes", "reason": "max-2147483648" }
  ]
}
```

- `type` URIs live under `https://studyforge.ai/errors/{code}` and resolve to a human-readable page.
- `code` is the stable machine identifier; clients pivot on it, never on `title`.
- `traceId` is the OTel trace id of the failing request; supplied for every error and surfaced in support tickets.
- `fields` is present for validation errors only.

All validation errors funnel through a single `ProblemException` mapping. Throwing `new BadRequestException(...)` in a controller is allowed; the global filter rewrites it to problem+json.

### Pagination — cursor-only

```
GET /v1/courses?cursor=eyJ0Ijo…&limit=20
```

Response shape:

```json
{
  "data": [ … ],
  "page": {
    "nextCursor": "eyJ0Ijo…" | null,
    "prevCursor": "eyJ0Ijo…" | null,
    "limit": 20
  }
}
```

- The cursor is opaque base64url of `{createdAt, id}`; clients never decode it.
- `limit` capped per-endpoint (default 20, max 100).
- Offset pagination is forbidden — it gives wrong answers under concurrent writes and breaks above ~10k rows.

### Idempotency

- Required on `POST` / `PATCH` / `DELETE` that allocate resources or trigger side effects (uploads, generation jobs, billing actions, chat messages).
- Header: `Idempotency-Key: <ulid>` — client-generated, ≤ 64 chars.
- Server stores `(tenantId, route, idempotencyKey) → (status, response, hash)` in Redis with a 24-hour TTL.
- Replays return the original response with `Idempotent-Replay: true`.
- A replay with a *different* request body returns `409 Conflict` + problem+json `code: idempotency.key-conflict`.

### Rate limiting

Per-tier, sliding window, Redis-backed. Replies always include:

```
RateLimit-Limit: 120
RateLimit-Remaining: 117
RateLimit-Reset: 47
RateLimit-Policy: "120;w=60"
```

When exhausted: `429 Too Many Requests` + `Retry-After: <seconds>` + problem+json. Tutor chat has a separate token-budget envelope tracked in `TokenBudget`; that exhaustion downshifts the model instead of returning 429 (per Operating Principle 11).

### Webhook signing

Outbound webhooks (LTI grade-passback, future student-event hooks) carry:

```
StudyForge-Signature: t=1715200000,v1=4dfe…
```

`v1` is `HMAC-SHA256(t + "." + body, secret)`. Receivers must:
1. Reject requests older than 5 minutes (`t`).
2. Constant-time compare the HMAC.
3. Treat replays (same `Idempotency-Key`) as no-ops.

Inbound webhooks (Stripe) use Stripe's native signature header verified by the SDK.

### Streaming — SSE schema

Every SSE endpoint emits `event:` typed messages. Tutor chat example:

```
event: meta
data: {"sessionId":"…","providerId":"groq","model":"llama-3.3-70b","tier":"free"}

event: token
data: {"delta":"Linear regression …"}

event: citation
data: {"chunkId":"…","page":12,"score":0.92,"spanStart":0,"spanEnd":34}

event: done
data: {"tokensIn":1820,"tokensOut":312,"cacheHit":true,"costMicroUsd":0}

event: error
data: {"code":"citation.missing","message":"refused: no source supports the answer"}
```

Clients close their `EventSource` on `done` or `error`. The server flushes a heartbeat `event: ping` every 15 s to keep proxies happy.

### Webhook receivers (Stripe)

`POST /v1/billing/stripe-webhook` — verified via `Stripe-Signature`. The handler is **idempotent on `event.id`** and writes a single `UsageEvent` / `Subscription` mutation per Stripe event.

### LTI 1.3

- `POST /v1/lti/login_initiation` — OIDC third-party initiated login per IMS spec.
- `POST /v1/lti/auth` — auth response receiver; verifies the `id_token` against the issuer JWKS and provisions/matches `(User, Course)` for the deployment.
- `GET /v1/lti/jwks` — our public keys for tools that read them.
- AGS (grade passback) and NRPS (roster sync) are bound to the resolved deployment_id.

---

## (b·ii) Endpoint catalog

### Auth & identity

| Method | Path | Description |
|---|---|---|
| POST | `/v1/auth/oauth/{provider}/start` | Begin OAuth (provider ∈ google · microsoft · github). Returns redirect URL. |
| GET  | `/v1/auth/oauth/{provider}/callback` | OAuth callback. Sets refresh cookie, returns access token. |
| POST | `/v1/auth/refresh` | Rotate refresh + return new access. |
| POST | `/v1/auth/logout` | Invalidate refresh family. |
| GET  | `/v1/me` | Current user + tenant + tier. |
| PATCH | `/v1/me` | Update locale, timezone, display preferences. |

### LTI 1.3

| Method | Path | Description |
|---|---|---|
| POST | `/v1/lti/login_initiation` | OIDC initiation. |
| POST | `/v1/lti/auth` | id_token receiver; provisions session. |
| GET  | `/v1/lti/jwks` | Public JWKS. |

### Tenants & institutions

| Method | Path | Description |
|---|---|---|
| GET  | `/v1/tenants/me` | Current tenant. |
| GET  | `/v1/institutions/{id}` | Public institution metadata. |

### Courses & enrollment

| Method | Path | Description |
|---|---|---|
| GET  | `/v1/courses` | List enrolled courses (cursor). |
| POST | `/v1/courses` | Create a course (instructor+). |
| GET  | `/v1/courses/{id}` | Detail + counts. |
| PATCH | `/v1/courses/{id}` | Update title / visibility / code. |
| DELETE | `/v1/courses/{id}` | Soft-delete. |
| POST | `/v1/courses/{id}/enrollments` | Enrol a user. |
| DELETE | `/v1/courses/{id}/enrollments/{userId}` | Drop a user. |

### Uploads, documents, chunks

| Method | Path | Description |
|---|---|---|
| POST | `/v1/uploads/init` | Pre-sign + reserve. `Idempotency-Key` required. |
| POST | `/v1/uploads/{id}/complete` | Mark upload complete, enqueue ingest. |
| GET  | `/v1/uploads/{id}` | Status + safety findings. |
| GET  | `/v1/documents` | List by `courseId` (cursor). |
| GET  | `/v1/documents/{id}` | Document + versions. |
| GET  | `/v1/documents/{id}/versions/{versionId}/chunks` | Cursor-paged chunk preview. |
| DELETE | `/v1/documents/{id}` | Soft-delete. |

### Knowledge graph

| Method | Path | Description |
|---|---|---|
| GET | `/v1/courses/{id}/concepts` | Concept list. |
| GET | `/v1/courses/{id}/concepts/{conceptId}` | Concept detail + adjacent edges. |
| GET | `/v1/courses/{id}/concept-edges` | Edges (filter by `kind`). |
| GET | `/v1/courses/{id}/graph` | Pre-rendered Cytoscape spec for fast first paint. |

### Roadmap & milestones

| Method | Path | Description |
|---|---|---|
| POST | `/v1/courses/{id}/roadmaps` | Generate (idempotent). |
| GET  | `/v1/courses/{id}/roadmaps/{roadmapId}` | Roadmap + milestones. |
| PATCH | `/v1/milestones/{id}` | Mark complete / skip / unlock. |

### Flashcards

| Method | Path | Description |
|---|---|---|
| POST | `/v1/courses/{id}/flashcards/generate` | Batch-generate. SSE progress. |
| GET  | `/v1/flashcards/decks/{deckId}` | Deck + cards. |
| POST | `/v1/flashcards/{id}/review` | SRS review submit. |

### Quizzes

| Method | Path | Description |
|---|---|---|
| POST | `/v1/courses/{id}/quizzes/generate` | Batch generate. |
| GET  | `/v1/quizzes/{id}` | Quiz + items (rationales hidden until graded). |
| POST | `/v1/quizzes/{id}/attempts` | Start attempt. |
| PATCH | `/v1/attempts/{id}/items/{itemId}` | Save answer. |
| POST | `/v1/attempts/{id}/submit` | Grade + update mastery. |

### Tutor chat

| Method | Path | Description |
|---|---|---|
| GET  | `/v1/chat/sessions` | List user's sessions. |
| POST | `/v1/chat/sessions` | New session bound to a course. |
| GET  | `/v1/chat/sessions/{id}/messages` | Cursor-paged history. |
| POST | `/v1/chat/sessions/{id}/messages` | Ask a question. Returns SSE stream. |
| WS   | `/v1/chat/sessions/{id}/stream` | Bidirectional channel for tool-use confirmations + cursors. |

### Search

| Method | Path | Description |
|---|---|---|
| GET | `/v1/search` | Hybrid (BM25 + dense + rerank) over tenant + optional `courseId`. |

### Notifications

| Method | Path | Description |
|---|---|---|
| GET   | `/v1/notifications` | Inbox (cursor). |
| PATCH | `/v1/notifications/{id}/read` | Mark read. |

### Billing

| Method | Path | Description |
|---|---|---|
| GET  | `/v1/billing/subscription` | Current subscription + usage. |
| POST | `/v1/billing/checkout` | Begin Stripe Checkout. |
| POST | `/v1/billing/portal` | Stripe Customer Portal link. |
| POST | `/v1/billing/stripe-webhook` | Stripe event receiver. |

### BYOK keys

| Method | Path | Description |
|---|---|---|
| GET   | `/v1/me/byok` | List keys (last4 + provider only). |
| POST  | `/v1/me/byok` | Add key. Validated server-side, then encrypted. |
| DELETE | `/v1/me/byok/{id}` | Revoke. |

### DSAR (compliance)

| Method | Path | Description |
|---|---|---|
| POST | `/v1/me/dsar/export` | Request data export (Art. 20). |
| POST | `/v1/me/dsar/delete` | Request erasure (Art. 17). Requires re-auth. |
| GET  | `/v1/me/dsar/{id}` | Status + signed download URL when ready. |

### Admin (institution / platform)

| Method | Path | Description |
|---|---|---|
| GET | `/v1/admin/tenants` | List tenants under the caller's institution. |
| GET | `/v1/admin/usage` | Aggregate UsageEvents (filtered, cursor-paged). |
| GET | `/v1/admin/audit` | Audit log slice (cursor). |
| POST | `/v1/admin/feature-flags/{name}` | Toggle / update targeting rules. |

### Health (unversioned)

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Liveness. |
| GET | `/health/ready` | Readiness (deps reachable). |
| GET | `/docs` | Swagger UI. |
| GET | `/openapi.json` | Generated spec. |

---

## (c) Trade-offs explicitly rejected

| Rejected | Reason |
|---|---|
| **GraphQL as the primary external surface** | Eats budget on resolvers + N+1 prevention + persisted query infra. REST + OpenAPI gives third-party developers, LMS integrators, and curl users a faster path. tRPC covers the internal type-safe seam. |
| **gRPC for service-to-service** | The polyglot mix (NestJS + FastAPI + sandbox-runner) makes Protobuf attractive, but plain HTTPS+JSON between services costs less in dev tooling and OTel instrumentation. We revisit if a single hot path proves it. |
| **JSON-API spec for response envelopes** | Heavyweight for what is mostly straightforward CRUD. Cursor envelopes + problem+json cover the same ground with less ceremony. |
| **Bearer access tokens in headers AND localStorage** | XSS risk. Access token lives in memory only; refresh token is HttpOnly Secure SameSite=Strict cookie. |
| **Per-endpoint version paths (`/v1/courses` vs `/v2/courses` independently)** | Operationally complex; clients can't reason about it. One global `/v{n}` prefix wins. |
| **Server-driven pagination links (HATEOAS `Link` headers)** | Decouples cursor format from client logic, but no client library in our stack consumes them well. Opaque cursor in JSON body covers the same use case. |
| **Polling for chat completions** | Wasted requests, latency floor of the poll interval, no incremental UI. SSE is strictly better here. |
| **WebSockets for everything realtime** | Heavier than SSE for one-way streams, requires sticky sessions in load balancers, breaks corporate proxies more often. We keep WS only for the genuinely bidirectional surface. |
| **Idempotency keys optional** | "Optional but recommended" idempotency is "idempotency that doesn't work." We require it on every state-changing endpoint where double-fire would create duplicate side effects. |
| **Returning HTTP 200 with `success: false`** | Confuses every client library and every monitoring tool. Status code carries the outcome; bodies carry detail. |
| **Embedding inline metrics in 200 responses** | Mixed concern — metrics belong in OTel, not API responses. Clients that need usage data call `/v1/billing/subscription` or `/v1/admin/usage`. |
| **Sending sensitive errors to clients (stack traces, SQL fragments)** | Information disclosure. The global filter strips them; only the safe `code + title + traceId` reaches the user. Operators correlate via `traceId`. |

---

## Next deliverables

- [Deliverable 5 — AI Pipeline (multi-agent)](./05-ai-pipeline.md) — the agents that drive most of these endpoints.
- [Deliverable 13 — Cost & Access](./13-cost-and-access.md) — defines the `RateLimit-*` policy and the BYOK / DSAR flows that this API surfaces.
