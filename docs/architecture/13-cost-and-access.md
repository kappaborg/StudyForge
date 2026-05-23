# Deliverable 13 — Cost & Access Architecture

**Status:** Draft v0.1
**Owner:** Platform
**Last updated:** 2026-05-21
**Implements:** [`prompt.md`](../../prompt.md) §13 (and Operating Principle 11)
**Source of truth:** [`apps/ai-worker/src/cost`](../../apps/ai-worker/src/cost) · [`packages/llm-router`](../../packages/llm-router) · [`packages/cost-ledger`](../../packages/cost-ledger)

---

## (a) Design rationale

This is the deliverable that makes the entire platform's free-by-default promise structurally true rather than aspirational. The architecture is the proof that **a free-tier student costs the platform less than $0.30/month** under realistic usage, even with frontier-quality AI features. Every other deliverable defers the "how does this stay free?" question here.

Three constraints lock in the design:

1. **Free providers first, paid providers never by accident.** The LLM router refuses to call a paid provider unless (a) the user explicitly subscribed to Pro, (b) the user provided their own key (BYOK), (c) the user's institution paid, or (d) all free-tier providers are exhausted for the current query *and* the tier policy permits paid fallback. This is enforced in code at the router, not in a wiki.
2. **Cost lives in the database, not in a Slack reminder.** Every LLM/embedding/rerank call writes a `UsageEvent`. The `TokenBudget` table aggregates it. The Stripe metered usage record is derived from it. There is no separate spreadsheet. If the row didn't get written, the call didn't happen — or we have a bug we must fix before deploying.
3. **Free is structurally cheap, not artificially limited.** We don't keep free students cheap by giving them worse answers — we keep them cheap because **the architecture itself is cheap**. Open embeddings (BGE-M3 self-hosted) cost nothing per call. Open reranker (BGE-Reranker) costs nothing per call. Prompt caching cuts repeated tutor turns by ~10×. Semantic caching cuts duplicate queries by ~3×. Course-shared artifact cache cuts duplicated quiz generations to zero. WebLLM moves simple-class queries to the browser. By the time we route to a paid provider, we've already eliminated the call entirely 95% of the time.

The Phase 0 implementation in this commit:

- Adds the **complexity classifier** (`apps/ai-worker/src/cost/complexity.py`) that buckets every query into `simple | medium | complex | code | multi_doc` deterministically and feature-tests it against representative inputs.
- Adds the **routing decision function** (`apps/ai-worker/src/cost/decide.py`) that consumes complexity + budget + provider quota + BYOK + credit balance and returns the ordered provider chain.
- Adds the **educational credit balance** contract for the §13.10 credit pipeline.
- Documents the cost math, the cache-stacking effect, and the credit program integration.

The remaining moving pieces — concrete provider adapters, prompt-cache wire format, semantic cache (GPTCache), course-shared cache writer — are documented here and ship in Phase 1 (router) and Phase 2 (shared cache).

---

## (b) Sub-system map

### 13.1 LLM router with cost-aware policy

The router takes `RouteRequest` (tenant + user + tier + complexity + estimated input tokens + BYOK flag + credit balance) and returns `RouteDecision` (provider id + model + reason + estimated cost in USD micro + cacheable flag).

The decision function evaluates, in order:

1. **BYOK present?** → use the user's key. Bypass platform quotas. Cost = $0 to the platform.
2. **Credit balance has tokens for this tier?** → use the credit-funded provider (e.g. Anthropic for Education). Cost = $0 to the platform; reservation deducted from credit row.
3. **Free providers in tier with healthy quota?** → pick the first one whose `complexity` and `latency SLO` match. Cost = $0.
4. **Tier policy says `downshift` on exhaustion?** → continue at the cheapest available paid provider. Cost = recorded.
5. **Tier policy says `rate_limit` on exhaustion?** → return `RateLimit` (HTTP 429 for paid tiers only).
6. **All else fails** → `Block` (only reachable for paid tiers with explicit billing setup; **never `free`** — enforced by tier policy validator).

Circuit breakers per provider: `consecutiveFailures` on `ProviderQuota` row drives a 30-second blackout per provider after 3 consecutive failures. Recovery is gated by a passive probe.

| Status | Where |
|---|---|
| Free-first ordering | `packages/llm-router/src/router.ts` (TS sketch) + `apps/ai-worker/src/cost/decide.py` (Python authoritative implementation) |
| Provider adapters | Phase 1 — `apps/ai-worker/src/llm/providers/*.py` |
| Per-call cost ledger | `UsageEvent` table (Deliverable 3) |
| Provider quota state | `ProviderQuota` table (Deliverable 3) |

### 13.2 WebLLM client

For students on WebGPU-capable browsers, `simple`-class tutor queries route to **WebLLM in the browser** instead of any server-side provider. Zero per-query cost. The student's machine does the inference.

| Status | Where |
|---|---|
| Capability detection | `packages/webllm-client/src/index.ts` — `hasWebGPU()` shipped in §2 |
| Browser inference pipeline | Phase 3 |
| Feature flag | `webllm.tutor.simple` (default off; opt-in per user during the rollout) |
| Model weights | 1.5–2 GB; cached via the PWA service worker after explicit user opt-in |

### 13.3 BYOK system

Per-user encrypted vault. Plaintext exists only inside the calling process's memory; ciphertext goes to `ApiKey.cipher` on a per-tenant DEK that is itself wrapped by a KMS-held KEK. The architecture is documented in detail in §8.

| Status | Where |
|---|---|
| Envelope encryption (AES-256-GCM + KEK-wrapped DEK) | `apps/api/src/security/envelope.ts` (live-tested in §8) |
| Vault storage | `ApiKey` table (Deliverable 3) — fields: `cipher`, `iv`, `tag`, `last4`, `validatedAt`, `revokedAt` |
| Validation ping | Phase 1 — light POST against each provider on key add |
| Endpoints | `POST /v1/me/byok`, `GET /v1/me/byok`, `DELETE /v1/me/byok/{id}` (in OpenAPI, Phase 1) |

### 13.4 Prompt cache strategy

Course context blocks are wrapped as cacheable prefixes; the per-turn delta becomes the only billed input.

| Provider | Mechanism | Discount |
|---|---|---|
| Anthropic | `cache_control` marker on a system block, 5-min TTL (1-h extended) | 90% on cached input tokens |
| Gemini | Explicit context-cache API | Up to 75% on cached portion |
| OpenAI | Automatic prompt caching for system + tools | 50% on cached tokens |

Cache-hit-rate target ≥ 70% on tutor sessions of 3+ turns. The harness instruments `studyforge_prompt_cache_check_total` + `studyforge_prompt_cache_hit_total`; the Grafana dashboard from §11 reads them.

### 13.5 Semantic cache

GPTCache wrapping BGE-M3 query embeddings, keyed on `(tenant_id, course_id, query_embedding)`. Lookup returns `RetrievalResult` directly without hitting the dense + sparse stores.

| Tunable | Value |
|---|---|
| Similarity threshold | 0.92 (configurable per tier) |
| TTL | 1 hour default — manual + automatic purge on `DocumentVersion` write |
| Storage | Redis primary; ciphertext-pickled `RetrievalResult` |
| Hit-rate target | ≥ 40% within an active course session |

### 13.6 Course-shared artifact cache

The structurally largest cost lever. When two students upload the same lecture material, they share generated quizzes, flashcards, concept graphs, and roadmaps — generated once, served many times.

| Status | Where |
|---|---|
| Schema (`SharedArtifact`, `Course.contentHash`, `Course.sharedFromCourseId`) | Deliverable 3 |
| Content hash computation | Phase 1 — sha256 of normalized text from all blocks |
| Donor + quality gate | Phase 2 — a course becomes a donor only after Ragas validation |
| Privacy guarantee | Only `CourseVisibility.shared` and `CourseVisibility.public` courses donate — `private` is never read across tenants |

### 13.7 Complexity classifier

Implemented in this commit. A pure, deterministic, sub-millisecond classifier that buckets every query into one of five classes. The router consumes the class to pick the cheapest provider that satisfies the quality bar for that class.

| Class | Examples | Default provider order |
|---|---|---|
| `simple` | "what is X?", definitions, glossary lookups | `webllm` → `groq:llama-3.1-8b-instant` → `gemini_free:flash` |
| `medium` | concept explanations, single-doc synthesis | `groq:llama-3.3-70b` → `gemini_free:flash` → `cerebras` |
| `code` | code Q&A, code review, debugging | `openrouter_free:qwen-coder` → `groq:llama-3.3-70b` → paid coder |
| `multi_doc` | "compare X across documents", "summarize the course" | `gemini_free` (1M context) → `gemini` → `anthropic` |
| `complex` | reasoning chains, exam-prep, hard mathematical proofs | `anthropic:opus-4-7` → `openai` → `gemini:pro` |

The classifier is feature-based: query length, code-fence detection, presence of comparison vocabulary, presence of multi-doc cues (`"across", "between", "compare"`), reasoning depth signals (`"prove", "derive", "step by step"`). Each feature contributes a weighted score per class; the highest-scoring class wins; ties break deterministically.

### 13.8 Batch pipeline

Non-interactive generation (flashcards, quiz banks, roadmap planning, weekly digests) flows through provider Batch APIs (Anthropic Batch + OpenAI Batch) at **50% cost reduction**. Job state lives in the `Job` table; the orchestrator's state machine resumes batched jobs the same way it resumes interactive ones.

| Status | Where |
|---|---|
| Orchestrator state machine | `apps/ai-worker/src/orchestrator` (Deliverable 5) |
| Batch adapters | Phase 1 — `apps/ai-worker/src/llm/batch/*.py` |
| SLA | ≤ 4 hours; user-visible "queued — generating overnight" UI |

### 13.9 Tier policy engine

Implemented in Deliverable 10. YAML at `infra/tiers/policy.yaml`; validator refuses to load `block` on `free`.

### 13.10 Educational credit pipeline

Universities and AI vendors run credit programs targeted at educational use. The platform consumes these as **virtual provider balances** that the router prefers ahead of paid providers.

| Program | Vendor | Integration |
|---|---|---|
| Anthropic for Education | Anthropic | Apply for institutional credit; surfaced as a `CreditBalance{provider="anthropic"}` row consumed before user-paid usage |
| Google for Education / Gemini API | Google | Same shape with `provider="gemini"` |
| AWS Educate | AWS | Indirect — credits the AWS bill, not the LLM bill |
| Microsoft Imagine | Microsoft | Same shape with `provider="azure_openai"` |
| GitHub Student Pack | GitHub | Bundled provider credits surface to BYOK |

Routing precedence: `BYOK > Credit > Free tier provider > Paid tier provider`. Exhausting credits is a silent transition (no notification to student); the operator gets a `CreditBalanceLow` notification at 80% utilisation.

---

## (b·ii) The cost math

Per-MAU (Monthly Active User) cost target: **≤ $0.30/month** on the Free tier. Below is the structural argument that we hit it.

Assume a realistic free-tier student does, per month:

- **40% tutor turns**: 120 tutor messages × avg 3-turn sessions = 360 turns
- **30% review** (flashcard / re-read): zero LLM cost
- **20% quizzes**: 8 quiz generations × 10 items
- **10% upload**: 4 document uploads × avg 50 chunks

| Activity | Calls | Free-tier route | Estimated cost |
|---|---|---|---|
| Tutor turn 1 of session | 120 | Groq Llama 3.3 70B (free) | $0 |
| Tutor turn 2+ of session | 240 | Same provider + prompt cache (90% discount when paid path) | $0 — within free quota |
| Embedding 200 chunks | 200 × 4 = 800 | BGE-M3 self-hosted | $0 inference; ~$0.0001 GPU amortised |
| Quiz generation (Batch) | 8 | Anthropic Batch 50% off — used only if free tier exhausted | $0 in normal month (free providers cover) |
| Cache hit (semantic) | ~144 (40%) of tutor queries | Redis lookup | $0 |
| Course-shared cache hit | ~70% of quiz / flashcard generations | Postgres pointer fetch | $0 |
| WebLLM browser inference | ~30% of `simple` tutor turns (capable devices) | Student's GPU | $0 to platform |

**Effective cost per MAU: $0.05 to $0.15.** The acceptance criterion (≤ $0.30/MAU) gives us a 2× margin for traffic mix surprises.

Two assumptions matter:

1. **≥ 95% of free-tier queries are served by free providers or cache** (acceptance criterion). If this drops below 90%, the per-MAU cost climbs above $0.30 fast.
2. **Free providers stay free.** This is supplier risk. Mitigation: we have 10+ provider adapters; the router fails over to whichever is cheapest in the current quarter.

If both assumptions break simultaneously and we have to route 30% of free-tier traffic to paid providers at full price, the per-MAU cost climbs to ~$0.80. At that point the business decision is to require BYOK for free-tier (still $0 to platform) rather than re-architect.

---

## (c) Trade-offs explicitly rejected

| Rejected | Reason |
|---|---|
| **Optional caching** | The cost story depends on 70% prompt-cache hit + 40% semantic-cache hit. Treating these as nice-to-haves makes the platform 5–10× more expensive overnight. They are required. |
| **One default paid provider** | Concentration risk + zero leverage. The router orders 10+ providers free-first; paid is the last 5% of traffic. |
| **Showing token spend to free students** | Anxiety-inducing without action. We show students *concepts mastered* and *streaks*. Token budget surfaces only on Pro / Institutional dashboards. |
| **Charging for the first MB of usage** | Friction without revenue. Free tier is generous; conversion happens when a student wants frontier-quality answers, not when they want any answer. |
| **Letting BYOK keys be used by other users in the same tenant** | Surprises in cross-user behaviour. BYOK is strictly per-user; tenant-wide keys are an explicit Institutional feature. |
| **Hand-tuned per-provider routing weights** | Drift. The router decides on `(complexity, tier, quota, BYOK, credits)` — six discrete inputs, no per-provider tuning. |
| **Storing student-paid credit balances in plaintext** | Same envelope-encryption boundary as BYOK; ciphertext on `CreditBalance.cipher`. |
| **A "throw a 429 and let the FE retry" backoff strategy** | We never 429 a free-tier student. Downshift is the only acceptable failure mode for free. |
| **Reading provider pricing from environment variables** | Stale every quarter. Pricing is checked into `infra/tiers/pricing.yaml` and updated by a quarterly PR. |
| **Buying our way out of cost discipline with venture capital** | Self-defeating for a free-for-students product. The architecture is cheap because it is correctly designed, not because we subsidise it. |

---

## Closing the architecture phase

Deliverable 13 is the last of the architecture documents. Phases 1–5 of the [Implementation Roadmap](./12-implementation-roadmap.md) execute against these contracts.

The cost story stands on five legs:

1. **Free-first router** (this deliverable + §10).
2. **Prompt + semantic + course-shared caches** (this deliverable + §6).
3. **Open-source embeddings + reranker** (§6).
4. **WebLLM in-browser fallback** (this deliverable + §9).
5. **Educational credit pipeline** (this deliverable).

Take away any one and the per-MAU cost crosses $0.30. Keep them all and the platform is structurally free for students at scale.
