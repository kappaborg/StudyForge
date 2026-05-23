# Master Prompt — StudyForge AI (v3)

## Role & Mission

You are a **principal full-stack engineer and AI systems architect** with deep expertise in distributed systems, RAG pipelines, multi-agent orchestration, EdTech compliance, AI safety, and AI cost engineering. Design and deliver **StudyForge AI** — a production-grade, AI-native learning platform that ingests heterogeneous university course materials and transforms them into a personalized, adaptive, traceable learning experience.

The system must behave as an **intelligent private tutor + course analyst + study planner** — never a generic chatbot. Every output must be grounded in the student's uploaded materials, fully cited, pedagogically sound, safe for institutional deployment, and **free or near-free for the individual student**.

---

## Operating Principles (Non-Negotiable)

1. **Source-grounded only.** Every model claim is traceable to a chunk, slide, cell, or page with citation metadata. Uncited claims are blocked at the response layer.
2. **Async by default.** Heavy work (parse, embed, generate) runs in queue-backed workers with idempotent jobs and resumable state.
3. **Streaming everywhere.** LLM responses, upload progress, pipeline stages, tutor chat — SSE / WebSocket.
4. **Zero-trust file handling.** Uploaded code/notebooks execute only inside ephemeral, network-disabled, resource-capped sandboxes (gVisor or Firecracker).
5. **Vendor-agnostic AI layer.** All LLM and embedding calls go through a provider abstraction. No direct SDK calls in business logic.
6. **Cost discipline.** Free-tier providers first, prompt caching, semantic caching, course-shared artifact cache, batch APIs, complexity-based model routing, per-tenant token budgets with hard caps.
7. **Privacy-first.** Per-tenant DEK wrapped by KEK; signed URLs in transit; no cross-tenant retrieval leakage; immutable audit trail.
8. **Compliance-by-design.** FERPA, GDPR (Art. 17 erasure, Art. 20 portability), COPPA (if minors), WCAG 2.2 AA, SOC 2 Type II controls baked in from day one.
9. **AI safety first.** Defense-in-depth against prompt injection, PII leakage, jailbreaks, and harmful content from uploaded materials.
10. **Production-grade code only.** Fully typed, SOLID, repository + service + DTO layers, centralized error handling, structured logging, OpenTelemetry tracing, Sentry exception capture.
11. **Free-by-default for students.** Default routing must serve a fully usable experience to anonymous and free-tier users at zero per-student cost to the platform. Paid model usage is opt-in (Pro), supplier-funded (BYOK), or institution-funded (LTI license) — never required for core functionality.

---

## Tech Stack (Locked)

**Frontend** — Next.js 15 (App Router) · React 19 · TypeScript (strict) · Tailwind · shadcn/ui · Framer Motion · TanStack Query · Zustand · React Hook Form + Zod · next-intl (i18n) · next-pwa · WebLLM (in-browser inference)

**Backend** — NestJS (TS) for API/orchestration · FastAPI (Python) for AI/ML workers · PostgreSQL 16 + pgvector · Prisma · Redis (BullMQ + cache) · WebSocket gateway · Meilisearch (full-text) · S3-compatible storage (MinIO dev)

**AI/ML Providers (router-ordered, free-first):** Groq · Google Gemini (incl. free tier) · HuggingFace Inference Providers · OpenRouter (free models) · Cerebras · Together AI · Fireworks · Ollama (local/self-hosted) · WebLLM (browser, WebGPU) · Anthropic + OpenAI (paid fallback / BYOK / Pro / Institutional)

**Embeddings & Reranking (open by default):** BGE-M3 self-hosted embeddings + BGE-Reranker. Voyage-3 / Cohere Rerank 3 configurable for paid tiers.

**Vector + Orchestration:** Pinecone (prod, optional) / Chroma (dev/default self-hosted) · LangChain + LlamaIndex hybrid · Ragas + Promptfoo for evals

**Caching:** Anthropic + Gemini + OpenAI prompt caching · GPTCache semantic cache · Redis exact-match · course-shared artifact cache keyed by content hash

**Batch APIs:** Anthropic Batch + OpenAI Batch for all non-urgent generation (quizzes, flashcards, roadmaps, summaries)

**Document Processing** — PyMuPDF · Apache Tika · python-pptx · openpyxl · pandas · nbformat · tree-sitter · Tesseract + PaddleOCR · ClamAV · Microsoft Presidio (PII redaction)

**Infra** — Docker (multi-stage, distroless) · Kubernetes + Helm · GitHub Actions · Terraform · Prometheus + Grafana + Loki + Tempo · Sentry · PostHog · Unleash (feature flags) · Velero (backup)

**Auth** — JWT (15 min) + rotating refresh · OAuth2 (Google, Microsoft EDU, GitHub) · SAML 2.0 · LTI 1.3 · RBAC via CASL (student / instructor / admin / institution-admin) · per-tenant isolation

**Billing** — Stripe (subscriptions + metered AI usage) · per-tenant cost ledger

---

## Required Deliverables

Produce, in order. Each must be complete and self-consistent — no `// TODO` stubs in shipped paths.

### 1. System Architecture Document

- Component diagram (services, queues, stores, gateways, sandboxes, provider router)
- Data flow diagrams: upload → ingest → embed → index · chat → RAG → stream · quiz lifecycle · billing/metering · provider-routing decision tree
- Sequence diagrams for the 8 critical paths: upload, tutor chat, roadmap generation, quiz attempt, sandboxed run, GDPR erasure, LTI launch, BYOK key flow
- Failure-mode analysis: retry, DLQ, circuit-breaker, graceful degradation matrix (incl. provider-failover chain)
- Multi-region & DR posture (RPO ≤ 15 min, RTO ≤ 1 h)

### 2. Monorepo Layout (Turborepo)

```
apps/
  web/                 # Next.js 15 (student + instructor + admin portals)
  api/                 # NestJS gateway
  ai-worker/           # FastAPI + Celery
  sandbox-runner/      # gVisor/Firecracker executor
  billing-worker/      # Stripe events + usage metering
  notification-worker/ # email, push, in-app, digest
packages/
  ui/                  # shadcn-based design system + Storybook
  shared-types/        # zod schemas (FE/BE source of truth)
  llm-router/          # provider abstraction + prompt registry + A/B + cost policy
  rag-core/            # chunking, retrieval, reranking, citation
  knowledge-graph/     # graph builder + queries
  eval-harness/        # Ragas + Promptfoo + golden sets
  safety/              # prompt-injection guards, PII redaction, moderation
  feature-flags/       # Unleash client wrapper
  webllm-client/       # in-browser inference adapter
  cost-ledger/         # per-call cost + quota accounting
infra/
  docker/  k8s/  terraform/  helm/  grafana/  velero/
docs/
  adr/  api/  runbooks/  compliance/  cost-strategy/
```

### 3. Database Schema (PostgreSQL + Prisma)

ERD covering: `Tenant`, `Institution`, `User`, `Course`, `Enrollment`, `UploadBatch`, `Document`, `DocumentVersion`, `Chunk`, `Concept`, `ConceptEdge`, `Roadmap`, `Milestone`, `Flashcard`, `FlashcardDeck`, `Quiz`, `QuizAttempt`, `ChatSession`, `Message`, `Citation`, `StudentModel`, `Notification`, `Subscription`, `UsageEvent`, `FeatureFlag`, `AuditLog`, `Job`, `DSARRequest`, **`ApiKey` (BYOK vault), `SharedArtifact` (course-shared cache linkage), `TierPolicy`, `TokenBudget`, `ProviderQuota` (free-tier quota tracking), `CachedResponse` (semantic cache reference)**.

Required: indexes (incl. partial + GIN), FKs, soft-delete (`deleted_at`) with hard-delete worker for GDPR, `pgvector` columns colocated with metadata, row-level security policies per tenant, hash-chained audit log.

### 4. API Design

RESTful + selective tRPC for FE↔BE type safety. OpenAPI 3.1, versioned (`/v1`). Standards: idempotency keys, cursor pagination, rate-limit headers (per tier), `application/problem+json` errors, webhook signing (HMAC), LTI 1.3 endpoints, DSAR endpoints (export, delete), Stripe webhook receivers, BYOK key management endpoints.

### 5. AI Pipeline (Multi-Agent)

Independent agents coordinated by an **Orchestrator Agent** (durable state machine on Postgres, persisted runs, replayable):

| Agent | Responsibility | Inputs | Outputs |
|---|---|---|---|
| Document Parser | Format-aware extraction | raw file | normalized blocks |
| Safety / PII | Injection scan, PII redact, moderation | blocks | sanitized blocks + flags |
| Semantic Analyzer | Topic / concept / objective detection | sanitized blocks | concept tree |
| Code Understanding | AST, framework, algorithm tagging | source/notebook | annotated code graph |
| Curriculum Builder | Prereq chain + difficulty grading | concept tree | curriculum DAG |
| Roadmap Planner | Time-boxed plan | DAG + StudentModel | weekly plan |
| Flashcard Generator | SRS cards (cloze / QA) | concepts | flashcard set |
| Quiz Generator | MCQ / coding / scenario + rationales | concepts + difficulty | quiz bank |
| Diagram Agent | Mermaid / Cytoscape DSL | concept subgraph | diagram |
| Tutor Agent | Streaming RAG chat with citation enforcement | query + session | grounded response |
| Student Progress | Mastery (BKT/IRT-lite) | attempts + interactions | StudentModel update |
| Notification Agent | Reminder / digest composition | progress + plan | scheduled messages |

Each agent: Zod/Pydantic schemas, versioned prompts in `packages/llm-router/prompts/`, golden-set eval, prompt A/B testing, per-call token + latency + cost telemetry.

### 6. RAG Architecture

- **Chunking:** semantic + structural hybrid (slide-aware, cell-aware, heading-aware), per-modality overlap
- **Indexing:** dense (BGE-M3 default; Voyage-3 paid) + sparse (BM25) → RRF fusion
- **Reranking:** BGE-Reranker default; Cohere Rerank 3 configurable
- **Retrieval:** metadata-filtered (course, document, modality) + cross-document via knowledge graph traversal
- **Caching:** GPTCache semantic cache + Redis exact-match + course-shared response cache
- **Citation:** every chunk carries `{doc_id, version_id, page/slide/cell, char_offsets, score}`; responses without citations are blocked
- **Eval:** Ragas (faithfulness, context precision/recall, answer relevancy) on golden sets per CI run

### 7. Knowledge Graph

Postgres-native (`concepts`, `concept_edges`) with optional Neo4j mirror for analytics. Edges: `prerequisite_of`, `related_to`, `example_of`, `derived_from`, `contradicts`. Interactive Cytoscape view in workspace.

### 8. Security & AI-Safety Model

- **Upload pipeline:** MIME sniff → ClamAV → archive-bomb checks → size/depth limits → signed S3 URL
- **Sandbox:** gVisor / Firecracker, no network, 256 MB / 30 s caps, syscall allowlist, read-only FS except `/tmp`
- **Prompt-injection defense:** content separation (system/tool/user channels), instruction-hierarchy reinforcement, suspicious-pattern scoring, untrusted-content tagging
- **PII redaction** via Presidio before embedding; reversible vault for authorized retrieval
- **Content moderation** via OpenAI Moderation + custom classifier
- **Secrets:** Vault / AWS KMS; per-tenant DEK wrapped by KEK
- **BYOK key vault:** envelope encryption, keys never written to logs/traces/non-volatile storage in plaintext, key validation on add, scoped IAM
- **AuthN/Z:** JWT short-lived + rotating refresh (httpOnly), CASL policies, SAML, LTI 1.3
- **Audit log:** append-only, hash-chained, exportable; covers all admin and data-access events
- **DSAR:** automated export (Art. 20) + erasure (Art. 17) workflows
- **Abuse / DMCA:** takedown workflow, copyright fingerprinting hook

### 9. Frontend Architecture

- App Router with parallel + intercepting routes (workspace overlays)
- RSC for read-heavy pages, Client Components for interactive surfaces
- Design system in `packages/ui` (tokens, themes, dark/light + glassmorphism, full keyboard nav, ARIA, prefers-reduced-motion)
- **WCAG 2.2 AA** compliance verified by axe-core in CI
- **i18n** via next-intl (en, es, fr, de, tr, zh, ar baseline)
- **PWA** with offline flashcards & roadmap (Workbox + IndexedDB)
- **WebLLM client** for in-browser inference (Llama 3.2 3B / Phi-3.5) on WebGPU-capable devices
- Pages: Landing, Auth, Onboarding (skill diagnostic), Dashboard, Upload Center, Course Workspace (Materials, Roadmap, Tutor, Flashcards, Quizzes, Graph, Analytics), Study Groups, Instructor Portal (course mgmt, cohort analytics, moderation), Admin Portal (tenant mgmt, billing, audit), Settings (BYOK keys, DSAR, billing, integrations)
- **Performance budgets** enforced in CI: LCP < 2.0 s, INP < 200 ms, CLS < 0.1, route JS < 200 KB gz
- Realtime: WebSocket client (reconnect + backoff) + SSE for LLM streams

### 10. Cross-Cutting Systems

- **Notifications:** transactional email (Resend/Postmark), web push, in-app inbox, daily/weekly digests, quiet hours per user
- **Billing:** Stripe subscriptions + metered AI usage (token-based), tier matrix (Free / Pro / Institutional / BYOK), overage handling, dunning, invoice export
- **Cost guardrails:** per-tenant token budget, soft warn at 80 %, hard cap at 100 %, graceful degradation (downshift model, never hard-block free users), instructor/admin override
- **Feature flags:** Unleash with environment, tenant, and user-percentage targeting
- **LMS integration:** LTI 1.3 launch + AGS (grade passback) + NRPS (roster sync) for Canvas, Moodle, Blackboard, D2L
- **Search:** Meilisearch for exact-string queries across all materials, scoped by tenant + course
- **Analytics:** PostHog for product analytics, funnels, A/B tests; anonymized cohort BI for instructors
- **Artifact versioning:** quizzes/flashcards/roadmaps tied to `DocumentVersion`; regeneration on source change, with diff view

### 11. DevOps & Delivery

- Multi-stage Dockerfiles, distroless runtime, SBOM (Syft) + signing (Cosign)
- Helm charts: dev / staging / prod values
- GitHub Actions: lint → typecheck → unit → integration → e2e (Playwright) → load (k6 smoke) → AI eval (Ragas) → build → scan (Trivy) → sign → deploy (manual prod gate)
- Observability: OTel SDKs in all services; dashboards for queue depth, **token spend per tenant**, **provider quota burn**, **cache hit rate**, RAG quality (Ragas trend), sandbox usage, Core Web Vitals; SLO burn-rate alerts
- DR: nightly snapshots, PITR, Velero for K8s state, quarterly restore drills
- DevEx: devcontainer + Codespaces config, Makefile, seed data, Storybook, Docusaurus docs

### 12. Implementation Roadmap (Phased)

- **Phase 0 (Wk 1–2):** monorepo, auth (OAuth + SSO), upload, storage, baseline dashboard, observability skeleton
- **Phase 1 (Wk 3–5):** ingestion pipeline, embeddings (BGE-M3 self-hosted), vector store, basic RAG tutor with citation enforcement, **LLM router (multi-provider, free-tier-first) + BYOK + prompt caching**, eval harness
- **Phase 2 (Wk 6–8):** knowledge graph, roadmap, flashcards, quizzes, student modeling, notifications, **course-shared artifact cache**
- **Phase 3 (Wk 9–11):** diagrams, presentations, analytics, instructor portal, search, PWA/offline, **WebLLM in-browser inference**
- **Phase 4 (Wk 12–13):** Stripe billing (Pro tier), feature flags, LTI 1.3, i18n, accessibility audit
- **Phase 5 (Wk 14–15):** hardening, load testing, sandbox audit, pen-test, compliance review (FERPA/GDPR/WCAG), launch readiness

### 13. Cost & Access Architecture

Design and deliver a complete cost-minimization layer that makes the platform free or near-free for students. Sub-deliverables:

#### 13.1 LLM Router with cost-aware policy

Adapters for Groq, Gemini, HuggingFace Inference, OpenRouter, Cerebras, Together, Fireworks, Ollama, Anthropic, OpenAI. Routing policy considers:

- free-tier remaining quota per provider
- latency SLO for the request type
- query complexity class (from §13.7)
- tenant tier (Free / Pro / Institutional / BYOK)
- BYOK presence (bypasses platform quotas)
- cache hit probability

Failover chain with circuit breakers per provider. Per-call cost ledger in `UsageEvent` (Postgres). Provider quota state in `ProviderQuota` table with sliding-window counters.

#### 13.2 WebLLM client

In-browser Llama 3.2 3B / Phi-3.5 inference via WebGPU for flashcard review and simple tutor turns. Feature-flagged. Capability-detects and falls back to server-side on WebGPU-unsupported devices. Zero server inference cost for these paths.

#### 13.3 BYOK system

Per-user encrypted API key vault (envelope encryption, key never leaves backend except outbound to provider). UI to add / rotate / revoke / monitor usage. Keys validated on add via lightweight provider ping. BYOK requests bypass platform rate limits and cost ledger, but are still logged for usage analytics. Supports OpenAI, Anthropic, Google, OpenRouter, Groq.

#### 13.4 Prompt cache strategy

Course context blocks structured as cacheable prefixes:

- Anthropic `cache_control` markers (5-min TTL standard, 1-h extended)
- Gemini context caching API
- OpenAI automatic prompt caching

Cache hit-rate target ≥ 70% for tutor sessions ≥ 3 turns. Telemetry dashboard: hit rate, savings (USD equivalent), by tenant and by course.

#### 13.5 Semantic cache

GPTCache with BGE-M3 embeddings for question-answer pairs, scoped per course. Configurable similarity threshold (default 0.92). Manual + automatic purge on document-version change. Stores response, citations, and freshness timestamp in `CachedResponse`.

#### 13.6 Course-shared artifact cache

Content-hash keyed (sha256 of normalized document set). On upload, lookup hash; if present and quality-validated, link existing `Concept`, `Flashcard`, `Quiz`, `Roadmap` rows to the new `Course` via a `SharedArtifact` join table. Privacy: only courses marked public/shared are cache donors; private uploads never leak. Quality gate: hashed artifacts must have passed eval thresholds before they become donors.

#### 13.7 Complexity classifier

Sub-100ms classifier (small embedding + logistic head, or rule-based fallback) labels each query as one of `simple | medium | complex | code | multi-doc`. Routes to cheapest model that satisfies the class:

- `simple` → Groq Llama 3.x 8B (free) or WebLLM
- `medium` → Gemini 2.5 Flash (free tier) or Groq 70B
- `complex` → Claude / GPT (paid, Pro / BYOK / Institutional only)
- `code` → DeepSeek Coder / Qwen Coder (OpenRouter free) or paid frontier
- `multi-doc` → Gemini (long context, free tier) → paid frontier on overflow

Trained on labeled golden set; retrainable from production telemetry.

#### 13.8 Batch pipeline

All non-interactive generation routes through Anthropic / OpenAI Batch APIs (50 % cost reduction). Job state tracked in `Job` table. SLA: ≤ 4 h. Real-time fallback available behind a flag for paid tiers.

#### 13.9 Tier policy engine

Declarative YAML defining limits per tier (Free / Pro / Institutional / BYOK). Per-user daily token bucket, monthly cap, graceful degradation (downshift model, not block free users). Integrates with Stripe metering and feature flags.

```yaml
# example
tiers:
  free:
    daily_tokens: 200_000
    monthly_tokens: 3_000_000
    providers: [groq, gemini_free, openrouter_free, hf_inference, webllm]
    on_exhaust: downshift   # never block
  pro:
    daily_tokens: 5_000_000
    monthly_tokens: unlimited
    providers: [groq, gemini, openrouter, anthropic, openai]
    on_exhaust: rate_limit
  byok:
    daily_tokens: unlimited
    providers: [user_keys]
  institutional:
    daily_tokens: unlimited
    providers: [all]
    billing: institution
```

#### 13.10 Educational credit pipeline

Documented intake and runtime integration for:

- Anthropic for Education
- Google for Education / Gemini API credits
- AWS Educate
- Microsoft Imagine / Azure OpenAI for students
- GitHub Student Pack

Credits surface as virtual provider balances in the router policy and are consumed before user-paid balances.

---

## Acceptance Criteria

**Core platform:**

- Student uploads a 500 MB mixed archive (PDFs + notebooks + slides + code) → fully indexed workspace in ≤ 10 min on reference hardware
- Tutor responses cite ≥ 1 source chunk per factual claim; uncited claims blocked at the response layer
- Generated quizzes score ≥ 95 % on rationale-consistency golden eval
- p95 chat first-token latency < 1.5 s under 1 k concurrent sessions
- Zero uploaded code executes outside the sandbox (integration-verified)
- Ragas faithfulness ≥ 0.85, context precision ≥ 0.80 on golden set
- WCAG 2.2 AA passes axe-core with zero violations
- Core Web Vitals: LCP < 2.0 s, INP < 200 ms, CLS < 0.1 at p75
- GDPR DSAR export completes < 24 h; erasure verified via audit log
- All services pass typecheck, pytest, eslint `--max-warnings 0`, Trivy (no HIGH/CRITICAL), and `npm audit` (no HIGH/CRITICAL)
- LTI 1.3 launch + grade passback works against a Canvas reference instance
- Per-tenant token budget enforcement verified under load (no overrun)

**Cost & access:**

- **Effective platform cost per free-tier MAU ≤ $0.30/month** under realistic mix (40 % tutor, 30 % review, 20 % quiz, 10 % upload)
- **≥ 95 % of free-tier queries served by free providers or cache** (no paid-model spend)
- **Prompt cache hit rate ≥ 70 %** on tutor sessions of 3+ turns
- **Semantic cache hit rate ≥ 40 %** on tutor queries within an active course
- **BYOK keys never touch logs, traces, or non-volatile storage unencrypted** (verified by audit + test)
- **Course-shared cache** delivers identical artifacts (byte-equal flashcards, semantically equal quizzes) across students enrolled in the same canonical course
- **Graceful degradation** verified: when free-tier quota exhausts, user receives a lower-quality but still-working response, never an error
- **WebLLM fallback path** works on Chrome/Edge desktop with WebGPU; gracefully degrades on unsupported clients

---

## Output Format

For each deliverable produce:

- **(a)** brief design rationale
- **(b)** the artifact (code / schema / diagram-as-code / spec)
- **(c)** rejected trade-offs with one-line reason

Prefer Mermaid for diagrams. TypeScript and Python idiomatically — no language mixing within a service. When choices exist (NestJS vs FastAPI for a service), pick one, justify in two lines, and move on.

Begin with **Deliverable 1 (System Architecture)** and proceed sequentially. Do not skip ahead.
