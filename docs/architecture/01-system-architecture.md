# Deliverable 1 — System Architecture

**Status:** Draft v0.1
**Owner:** Platform
**Last updated:** 2026-05-21
**Implements:** [`prompt.md`](../../prompt.md) §1

This document is the canonical architecture reference for StudyForge AI. It precedes the database schema, API design, and AI-pipeline specs, and is referenced by every subsequent deliverable.

---

## (a) Design rationale

StudyForge AI is a **multi-tenant, async-first, RAG-grounded** learning platform with three load-bearing constraints baked into every layer:

1. **Cost must approach zero per free student.** The platform must remain economically viable while charging the average student nothing. This drives a **free-tier-first LLM router**, aggressive **prompt + semantic + course-shared caching**, and **batch APIs** for non-urgent generation. Everything paid is opt-in (Pro), supplier-funded (BYOK), or institution-funded (LTI license).
2. **Source-grounded responses are non-negotiable.** Uncited model output is a defect, not a feature toggle. The architecture treats citations as a first-class data type and blocks responses that lack them at the response layer.
3. **Uploaded content is untrusted.** Code/notebooks may carry prompt injections, malware, copyright violations, or PII. The pipeline therefore runs a **safety stage before embedding** and isolates all code execution inside **gVisor/Firecracker sandboxes** with no network.

The shape of the system follows directly from these constraints:

- A **gateway** (NestJS) owns auth, validation, rate-limits, and orchestration. It never talks to LLM providers — every call goes through `packages/llm-router`.
- A **Python AI worker fleet** (FastAPI + Celery) handles parsing, embedding, and generation because the Python ML ecosystem dominates here. Each agent is an independent Celery task with a typed input/output schema and a golden-set eval.
- **Postgres + pgvector + Redis + Meilisearch** form the data plane. We deliberately keep vector storage in Postgres in dev (and pluggably in Pinecone in prod) to avoid a parallel index management surface for small tenants.
- **Sandbox-runner** is a separate service so the blast radius of a sandbox escape is contained outside the application network.
- **Realtime** is split: SSE for one-way LLM streams (simplest possible), WebSockets only for the bidirectional surfaces (chat, live pipeline progress).
- **Observability** uses OpenTelemetry traces end-to-end so that a single tutor turn — gateway → router → cache → provider → response — produces one continuous trace. Without that, optimising cost or latency is guesswork.

The rest of this document specifies the component topology, the data flows, the eight critical sequences, the failure-mode matrix, and the multi-region/DR posture. Trade-offs explicitly rejected appear at the end.

---

## (b) Architecture artifacts

### 1. Component diagram

```mermaid
flowchart LR
  subgraph Client["Client tier"]
    Browser["Browser (Next.js 15)"]
    PWA["PWA shell + IndexedDB"]
    WebLLM["WebLLM (WebGPU)"]
  end

  subgraph Edge["Edge"]
    CDN["CDN / Edge cache"]
    WAF["WAF + rate limit"]
  end

  subgraph App["Application plane"]
    API["NestJS gateway"]
    WS["WebSocket gateway"]
    SSE["SSE responder"]
  end

  subgraph Workers["Worker plane (Celery / BullMQ)"]
    Ingest["Ingest worker"]
    Embed["Embed worker"]
    Gen["Generate worker"]
    Notif["Notification worker"]
    Bill["Billing worker"]
    Orchestrator["Orchestrator (state machine)"]
  end

  subgraph Safety["Safety + sandboxing"]
    SafetyGate["Safety gate (Presidio, injection score, moderation)"]
    Sandbox["sandbox-runner (gVisor / Firecracker)"]
  end

  subgraph Data["Data plane"]
    PG[("PostgreSQL 16 + pgvector")]
    Redis[("Redis (queues + cache)")]
    S3[("S3 / MinIO")]
    Meili[("Meilisearch")]
    Chroma[("Chroma / Pinecone")]
  end

  subgraph AI["AI plane"]
    Router["LLM Router (free-first)"]
    PromptCache["Prompt cache"]
    SemCache["Semantic cache (GPTCache)"]
    Shared["Course-shared artifact cache"]
    Providers["Providers: Groq · Gemini · HF · OpenRouter · Cerebras · Together · Fireworks · Ollama · Anthropic · OpenAI"]
  end

  subgraph Obs["Observability + control"]
    OTel["OTel collector"]
    Prom["Prometheus"]
    Loki["Loki"]
    Tempo["Tempo"]
    Sentry["Sentry"]
    PostHog["PostHog"]
    Unleash["Unleash (flags)"]
    Vault["Vault / KMS"]
  end

  Browser --> CDN --> WAF --> API
  Browser -.SSE/WS.-> WS
  Browser --> WebLLM
  PWA --> Browser

  API <--> PG
  API <--> Redis
  API <--> S3
  API <--> Meili
  API --> Orchestrator
  API --> Router
  Router --> PromptCache
  Router --> SemCache
  Router --> Shared
  Router --> Providers
  WebLLM -.fallback.-> Router

  Orchestrator --> Ingest
  Orchestrator --> Embed
  Orchestrator --> Gen
  Orchestrator --> Notif
  Orchestrator --> Bill

  Ingest --> SafetyGate
  SafetyGate --> Embed
  Embed --> Chroma
  Ingest --> Sandbox
  Gen --> Router

  API --> Vault
  Workers --> OTel
  API --> OTel
  Router --> OTel
  OTel --> Prom
  OTel --> Loki
  OTel --> Tempo
  API --> Sentry
  Browser --> PostHog
  API --> Unleash
```

### 2. Data flow diagrams

#### 2.1 Upload → ingest → embed → index

```mermaid
flowchart LR
  U[User] -->|"POST /uploads/init"| API
  API -->|"signed URL"| U
  U -->|"PUT file"| S3
  S3 -->|"object created"| API
  API -->|"enqueue ingest"| Q[(Redis queue)]
  Q --> ING[Ingest worker]
  ING --> MIME{MIME ok?}
  MIME -->|no| DLQ[(Dead letter)]
  MIME -->|yes| AV[ClamAV scan]
  AV --> BOMB[Archive-bomb check]
  BOMB --> EXTRACT[Format-specific extract]
  EXTRACT --> SAFETY[Safety gate: PII / injection / moderation]
  SAFETY -->|flagged| QUAR[Quarantine + notify user]
  SAFETY -->|clean| CHUNK[Semantic + structural chunking]
  CHUNK --> HASH[Content hash]
  HASH -->|"hit"| LINK[Link to SharedArtifact]
  HASH -->|"miss"| EMBED[Embed BGE-M3]
  EMBED --> VEC[(pgvector / Chroma)]
  EMBED --> META[(Postgres metadata)]
  EMBED --> FT[Meilisearch index]
  LINK --> WS[Notify WS: ready]
  EMBED --> WS
```

#### 2.2 Chat query → RAG → stream

```mermaid
flowchart LR
  U[User] -->|"WS: tutor.ask"| API
  API --> CLS[Complexity classifier]
  CLS --> POLICY[Tier policy + quota check]
  POLICY -->|denied| DEGRADE[Downshift model]
  POLICY -->|ok| HYB[Hybrid retrieval: dense + BM25 + RRF]
  DEGRADE --> HYB
  HYB --> RERANK[BGE-Reranker]
  RERANK --> SEM{Semantic cache hit?}
  SEM -->|yes| RET[Return cached + cite]
  SEM -->|no| ROUTE[LLM router]
  ROUTE --> PCACHE[Prompt cache lookup]
  PCACHE --> PROV[Provider call - streaming]
  PROV --> CITE[Citation enforcement]
  CITE -->|missing| REFUSE[Refuse w/ suggestions]
  CITE -->|ok| STREAM[SSE → user]
  STREAM --> LEDGER[Cost ledger update]
  RET --> STREAM
```

#### 2.3 Quiz generation lifecycle

```mermaid
flowchart LR
  U[User: generate quiz] --> API
  API --> ORCH[Orchestrator: quiz.lifecycle.v1]
  ORCH --> SEL[Select concepts from graph]
  SEL --> HASH[Hash concept set]
  HASH -->|hit| LINK[Link SharedArtifact]
  HASH -->|miss| BATCH{Pro or interactive?}
  BATCH -->|interactive| GENNOW[Generate now via router]
  BATCH -->|batch| ENQ[Submit Anthropic/OpenAI Batch]
  GENNOW --> ITEMS[Items + rationales + citations]
  ENQ -->|"≤ 4 h"| ITEMS
  ITEMS --> EVAL[Rationale consistency eval ≥ 0.95]
  EVAL -->|pass| STORE[(Postgres quizzes + items)]
  EVAL -->|fail| REGEN[Regenerate failed items]
  STORE --> WS[Notify user ready]
  STORE --> DONOR{Course public?}
  DONOR -->|yes| SHARE[Promote to SharedArtifact donor]
```

#### 2.4 Billing / metering

```mermaid
flowchart LR
  ROUTE[Every provider call] --> UE[(UsageEvent row)]
  UE --> AGG[Hourly aggregator]
  AGG --> CL[Cost ledger]
  CL --> POLICY{Tier policy check}
  POLICY -->|"< 80%"| OK[noop]
  POLICY -->|"≥ 80%"| WARN[Soft warn notification]
  POLICY -->|"≥ 100%"| DEG[Downshift / rate limit]
  CL -->|"hourly"| STRIPE[Stripe metered usage record]
  STRIPE --> INV[Monthly invoice]
  WH[Stripe webhook] --> BW[billing-worker]
  BW --> SUB[(Subscription row)]
```

### 3. Sequence diagrams — the eight critical paths

#### 3.1 Upload (resumable)

```mermaid
sequenceDiagram
  autonumber
  actor U as User
  participant W as Web
  participant API as NestJS gateway
  participant S3 as Object store
  participant Q as Redis queue
  participant ING as Ingest worker
  participant DB as Postgres

  U->>W: drag file
  W->>API: POST /v1/uploads/init {sha256, size, mime}
  API->>DB: insert UploadBatch (state=initiated)
  API->>S3: presign PUT URL
  API-->>W: {uploadId, signedUrl, expiresAt}
  W->>S3: PUT (resumable, chunked)
  S3-->>W: 200
  W->>API: POST /v1/uploads/{id}/complete
  API->>DB: UploadBatch state=uploaded
  API->>Q: enqueue ingest.process(uploadId)
  API-->>W: 202 Accepted
  Q->>ING: dequeue
  ING->>S3: get object
  ING->>ING: MIME + ClamAV + bomb + safety
  ING->>DB: write Document + Chunks
  ING->>API: WS notify upload.ready
  API-->>W: WS upload.ready
```

#### 3.2 Tutor chat (streaming, cited)

```mermaid
sequenceDiagram
  autonumber
  actor U as User
  participant W as Web
  participant API as NestJS
  participant CL as cost-ledger
  participant R as RAG core
  participant LR as LLM router
  participant P as Provider
  participant DB as Postgres

  U->>W: ask question
  W->>API: WS tutor.ask {sessionId, text}
  API->>CL: check quota
  CL-->>API: ok (or downshift hint)
  API->>R: retrieve(courseId, query)
  R->>R: hybrid (dense+BM25) + rerank
  R-->>API: top-k chunks + scores
  API->>LR: route(complexity, tier)
  LR-->>API: decision {providerId, model}
  API->>P: stream completion (prompt cache marker set)
  P-->>API: tokens (SSE)
  API->>API: enforce citation per claim
  API-->>W: SSE chunks
  API->>DB: Message + Citation rows
  API->>CL: record UsageEvent
```

#### 3.3 Roadmap generation

```mermaid
sequenceDiagram
  autonumber
  actor U as User
  participant API as NestJS
  participant O as Orchestrator
  participant CB as Curriculum Builder
  participant SM as Student model
  participant RP as Roadmap Planner
  participant DB as Postgres

  U->>API: POST /v1/courses/{id}/roadmap
  API->>O: start run roadmap.v1
  O->>CB: build DAG(courseId)
  CB-->>O: curriculum DAG
  O->>SM: fetch StudentModel(userId)
  SM-->>O: mastery vector
  O->>RP: plan(DAG, StudentModel, deadline)
  RP-->>O: weekly milestones
  O->>DB: persist Roadmap + Milestones
  O-->>API: run complete
  API-->>U: roadmap ready
```

#### 3.4 Quiz attempt

```mermaid
sequenceDiagram
  autonumber
  actor U as User
  participant W as Web
  participant API as NestJS
  participant DB as Postgres
  participant SP as Student Progress

  U->>W: start quiz
  W->>API: POST /v1/quizzes/{id}/attempts
  API->>DB: create QuizAttempt
  loop per item
    W->>API: PATCH /v1/attempts/{id}/items/{itemId}
    API->>DB: store answer
  end
  W->>API: POST /v1/attempts/{id}/submit
  API->>DB: grade + persist
  API->>SP: update mastery (BKT/IRT-lite)
  SP-->>API: new StudentModel snapshot
  API-->>W: result + recommended next topics
```

#### 3.5 Sandboxed code run

```mermaid
sequenceDiagram
  autonumber
  actor U as User
  participant API as NestJS
  participant W as ai-worker
  participant SR as sandbox-runner
  participant DB as Postgres

  U->>API: POST /v1/runs {snippet, lang}
  API->>W: enqueue run.exec
  W->>SR: gRPC Exec(snippet)
  Note over SR: gVisor / Firecracker<br/>no network · 256 MB · 30 s · syscall allowlist
  SR-->>W: stdout/stderr/exit/usage
  W->>DB: persist Run row
  W-->>API: run.complete
  API-->>U: result
```

#### 3.6 GDPR erasure (DSAR Art. 17)

```mermaid
sequenceDiagram
  autonumber
  actor U as User
  participant API as NestJS
  participant DSAR as DSAR service
  participant Q as Redis queue
  participant ER as Eraser worker
  participant DB as Postgres
  participant S3 as Object store
  participant V as Vector store
  participant AL as Audit log

  U->>API: DELETE /v1/me (with re-auth)
  API->>DSAR: open DSARRequest (kind=erasure)
  DSAR->>Q: enqueue erase.user(userId)
  Q->>ER: dequeue
  ER->>DB: soft-delete user-owned rows
  ER->>S3: delete user objects (versioned + lifecycle purge)
  ER->>V: delete vectors for user docs
  ER->>DB: hard-delete after grace window
  ER->>AL: append immutable erasure receipt
  ER-->>DSAR: complete (≤ 24 h)
  DSAR-->>U: confirmation email + receipt id
```

#### 3.7 LTI 1.3 launch (Canvas → StudyForge)

```mermaid
sequenceDiagram
  autonumber
  actor I as Instructor
  participant C as Canvas (LMS)
  participant API as NestJS
  participant Inst as Institution record
  participant W as Web

  I->>C: launch StudyForge tool
  C->>API: OIDC login_initiation
  API->>C: auth request (state, nonce)
  C->>API: id_token (JWS)
  API->>API: verify signature against JWKS
  API->>Inst: resolve issuer + deployment_id
  API->>API: provision/match user + course
  API-->>W: signed app session (cookie)
  W-->>I: open course workspace
  Note over API,Inst: AGS/NRPS bound to this deployment
```

#### 3.8 BYOK key flow

```mermaid
sequenceDiagram
  autonumber
  actor U as User
  participant W as Web
  participant API as NestJS
  participant Vault as KMS / Vault
  participant LR as LLM router
  participant P as Provider

  U->>W: paste provider key
  W->>API: POST /v1/me/byok {provider, key}
  API->>API: validate via lightweight provider ping
  API->>Vault: encrypt (envelope w/ tenant DEK)
  Vault-->>API: ciphertext + key id
  API->>API: persist ApiKey row (ciphertext only)
  API-->>W: success (last4 fingerprint only)
  U->>API: tutor.ask (later)
  API->>LR: route(byokKeyId=...)
  LR->>Vault: decrypt at call time
  Vault-->>LR: plaintext (memory only)
  LR->>P: completion w/ user key
  P-->>LR: tokens
  Note over LR: key never logged, traced, or persisted in plaintext
```

### 4. Failure-mode matrix

| Failure | Detection | Default response | Retry | DLQ | Degradation |
|---|---|---|---|---|---|
| Provider 5xx / timeout | Circuit breaker per-provider sliding window | Failover to next free provider | exp backoff, 3 tries | n/a | downshift class |
| Provider quota exhausted | Pre-flight `ProviderQuota` row | Skip provider in router | n/a | n/a | downshift to next free |
| Redis unavailable | health probe + connection failure | refuse new background jobs; in-flight degrade | exp backoff | n/a | API stays up, jobs deferred |
| Postgres primary down | LB / patroni failover | reads from replica if possible | retry with jitter | n/a | writes 503 with Retry-After |
| Object store error | upload HEAD | mark UploadBatch failed | 5 tries | dead-letter | user re-uploads (resumable) |
| Sandbox timeout / OOM | enforced by runtime | mark Run failed | none (idempotent re-submit) | n/a | user fix-and-retry |
| Embedding model OOM | worker process metric | downscale batch size | yes | after 3 fails | switch to remote BGE endpoint |
| Citation enforcement fails | response post-processor | refuse + suggest related | n/a | n/a | user reformulates |
| Stripe webhook unverified | signature mismatch | 400 + log | none | yes | manual reconciliation runbook |
| RAG quality regression (Ragas) | nightly eval job | block deploy on PR | n/a | n/a | rollback to last green prompt version |
| Cost cap breached (tenant) | hourly aggregator | hard cap on paid models | n/a | n/a | route only to free providers |
| ClamAV positive | scan result | quarantine + flag uploader | n/a | yes (review) | user notified |
| Prompt injection signal | safety gate score > threshold | strip and tag content channel | n/a | yes (review) | retrieval proceeds with untrusted tag |

All workers use **idempotency keys** (`Job.idempotency_key`) keyed on inputs so retries never produce duplicate side effects.

### 5. Multi-region and DR posture

| Concern | Posture |
|---|---|
| Primary region | One region per data-residency zone (e.g. `us-east-1`, `eu-west-1`). Per-tenant residency stored on `Tenant.region`. |
| Secondary region | Warm standby for compute (Helm-deploy-on-failover), cross-region read replica for Postgres, S3 cross-region replication for upload bucket. |
| Postgres backups | Continuous WAL archiving + nightly snapshot; **PITR window: 7 days**. |
| RPO | ≤ 15 minutes (WAL ship interval). |
| RTO | ≤ 1 hour (Helm deploy + DNS cutover + replica promotion). |
| Object store | Versioned bucket + cross-region replication; lifecycle rules expire DSAR-erased objects in 24 h. |
| Vector store | Re-buildable from Postgres `Chunk` + embedding cache; treated as a tertiary backup, not gold copy. |
| Secrets | KMS keys regional, with cross-region wrapping for break-glass. |
| Restore drills | Quarterly: full restore into an isolated namespace, verified by smoke suite. |

## (c) Trade-offs explicitly rejected

| Rejected option | Reason |
|---|---|
| **A single monolithic service (Node only)** | The ML toolchain (PyMuPDF, PaddleOCR, Presidio, Ragas) is decisively Python; bridging via subprocess is fragile. NestJS + FastAPI split chosen. |
| **Direct provider SDK calls from controllers** | Couples business logic to vendor APIs and defeats the free-tier-first cost lever. Everything goes through `packages/llm-router`. |
| **Neo4j as primary store for the knowledge graph** | Adds an operational store for a feature that is easily expressed as two Postgres tables with proper indexes. Optional Neo4j mirror remains available for analytics. |
| **Pinecone as the dev default** | Cost during local development and increased CI complexity. Chroma in dev, Pinecone optional in prod. |
| **Synchronous file processing in the request path** | Breaks the 500 MB / 10-minute acceptance criterion and turns p95 latency into provider-dependent noise. All ingestion is async. |
| **WebSockets for LLM streaming** | Over-engineered for a one-way stream; SSE is simpler, proxy-friendly, and reconnects natively. WS retained only for bidirectional surfaces. |
| **One Kubernetes namespace per tenant** | Massive operational overhead. Tenancy is enforced at the row level (RLS) and the storage prefix; clusters stay shared. |
| **Hard-blocking free users on quota exhaustion** | Breaks the "free-by-default" principle. Free users always get an answer, even if from WebLLM or a smaller model. |
| **A single LLM provider with retries** | Concentration risk (rate limits, outages, price changes) and removes the free-tier cost lever. Free-first router is mandatory. |
| **Ad-hoc prompt edits in code** | Untestable and unrollback-able. All prompts live in `packages/llm-router/prompts` with a version and a golden-set eval. |
| **Allowing model output without citations as a soft warning** | Defeats the source-grounded principle. Citations are enforced at the response layer; missing citations cause refusal, not degradation. |
| **Running uploaded code inside the ai-worker container** | A single sandbox escape would compromise the embedding store and provider credentials. Hard separation into `sandbox-runner` is mandatory. |

---

## Next deliverables

- [Deliverable 2 — Monorepo layout](../../README.md#repository-layout) (implemented in this commit).
- [Deliverable 3 — Database schema (Prisma + pgvector)](./03-database-schema.md) (next).
- [Deliverable 4 — API design (OpenAPI 3.1)](./04-api-design.md).
- [Deliverable 5 — AI pipeline (multi-agent)](./05-ai-pipeline.md).
- See `prompt.md` for the full sequence.
