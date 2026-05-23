# StudyForge AI

Production-grade, AI-native learning platform that ingests university course materials and turns them into a personalized, adaptive, cited learning experience.

**Free for every student. Forever.** No paywall, no subscription, no ads, no data resale. See [`/about`](http://localhost:3000/about) once running for the sustainability story.

The full product specification lives in [`prompt.md`](./prompt.md). Architecture decisions and design artifacts live under [`docs/`](./docs).

---

## Self-host in 5 steps

The whole stack runs on your laptop with one command. No SaaS dependencies required.

```bash
# 1. Clone
git clone https://github.com/kappaborg/studyforge.git
cd studyforge

# 2. Bootstrap (installs pnpm + Python deps, copies .env.example → .env)
make bootstrap

# 3. Start infra (Postgres + pgvector, Redis, MinIO, Meilisearch, Chroma)
make up

# 4. (optional) Add a free Groq API key for real LLM responses
#    Without it, the agents return deterministic stub output from your chunks.
echo "GROQ_API_KEY=gsk_..." >> apps/ai-worker/.env

# 5. Run
make dev
```

Open http://localhost:3000 → upload a PDF → done.

---

## Quick start

Prerequisites:

- Node.js 20.18+ (see `.nvmrc`)
- pnpm 9+
- Python 3.11+ with [uv](https://docs.astral.sh/uv/) (for `ai-worker` and `sandbox-runner`)
- Docker + Docker Compose

```bash
make bootstrap   # install deps, seed .env
make up          # start postgres / redis / minio / meilisearch / chroma / ollama / clamav
make dev         # run all apps in dev mode
```

Open:

| Surface | URL |
| --- | --- |
| Web (Next.js) | http://localhost:3000 |
| API (NestJS) | http://localhost:3001 |
| API OpenAPI docs | http://localhost:3001/docs |
| AI worker (FastAPI) | http://localhost:8001 |
| MinIO console | http://localhost:9001 |
| Meilisearch | http://localhost:7700 |
| Chroma | http://localhost:8000 |

---

## Repository layout

```
apps/
  web/                 Next.js 15 (student + instructor + admin portals)
  api/                 NestJS gateway
  ai-worker/           FastAPI + Celery (parsing, embedding, generation)
  sandbox-runner/      gVisor/Firecracker executor for uploaded code
  billing-worker/      Stripe events + usage metering
  notification-worker/ Email, push, in-app, digest

packages/
  ui                Design system (shadcn/ui + Tailwind tokens)
  shared-types      Zod schemas shared FE/BE
  llm-router        Provider abstraction + cost policy + prompt registry
  rag-core          Chunking, retrieval, reranking, citation enforcement
  knowledge-graph   Concept graph builder + queries
  eval-harness      Ragas + Promptfoo + golden sets
  safety            Prompt-injection guards, PII redaction, moderation
  feature-flags     Unleash client wrapper
  webllm-client     In-browser inference adapter
  cost-ledger       Per-call cost + quota accounting

infra/
  docker/  k8s/  terraform/  helm/  grafana/  velero/

docs/
  architecture/    Numbered architecture documents (Deliverable 1+)
  adr/             Architecture Decision Records
  api/             Generated OpenAPI specs
  runbooks/        On-call and ops playbooks
  compliance/      FERPA / GDPR / WCAG evidence
  cost-strategy/   Free-tier + BYOK + caching design notes
```

---

## Core principles

1. **Source-grounded** — every model claim cites a chunk; uncited claims are blocked.
2. **Async by default** — heavy work runs in queue-backed workers.
3. **Streaming everywhere** — SSE/WebSocket for LLM responses and pipeline progress.
4. **Zero-trust file handling** — uploaded code never executes outside ephemeral sandboxes.
5. **Vendor-agnostic AI** — every LLM/embedding call goes through `packages/llm-router`.
6. **Cost discipline** — free providers first, prompt caching, semantic + course-shared caches.
7. **Privacy-first** — per-tenant encryption, signed URLs, immutable audit trail.
8. **Compliance-by-design** — FERPA, GDPR, COPPA, WCAG 2.2 AA from day one.
9. **AI safety first** — prompt injection, PII, jailbreak, content moderation defenses.
10. **Production-grade code only** — typed, SOLID, structured logs, OTel tracing.
11. **Free-by-default for students** — usable end-to-end at zero per-student platform cost.

---

## Documentation

- [`prompt.md`](./prompt.md) — the master product specification (v3)
- [`docs/architecture/01-system-architecture.md`](./docs/architecture/01-system-architecture.md) — Deliverable 1
- [`docs/adr/`](./docs/adr) — Architecture Decision Records

Generated assets (OpenAPI, ERD, Storybook) are produced by CI and are not checked in.
