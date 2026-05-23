.DEFAULT_GOAL := help
SHELL := /bin/bash

.PHONY: help bootstrap dev up up-ai up-full down logs ps clean reset psql redis-cli \
        web api ai-worker fmt lint typecheck test build \
        db-setup db-migrate db-reset prisma-studio \
        eval-tutor

help: ## Show this help
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

bootstrap: ## Install all dependencies and copy .env
	@test -f .env || cp .env.example .env
	pnpm install --frozen-lockfile=false
	@echo "Bootstrap complete. Edit .env then run: make up && make dev"

eval-tutor: ## Run the Ragas-lite eval gate against tutor.answer.v1
	cd apps/ai-worker && uv run python -m src.eval.cli \
	  --prompt tutor.answer.v1 \
	  --golden golden/tutor_answer_v1.jsonl \
	  --min-pass-rate 1.0 \
	  --min-citation-validity 0.95 \
	  --min-refusal-consistency 1.0

e2e: ## Run Playwright + axe-core e2e suite against a running stack
	cd apps/web && pnpm e2e

load-test: ## Ingest load test (1 MB smoke). See docs/architecture/load-test.md
	cd apps/ai-worker && PYTHONPATH=. uv run python scripts/ingest_load_test.py --count 1 --size-mb 1

audit: ## Security: pnpm audit (high+) + pip-audit on the worker
	@echo "→ pnpm audit (high+)"
	pnpm audit --prod --audit-level=high || true
	@echo ""
	@echo "→ pip-audit (apps/ai-worker)"
	@command -v pip-audit >/dev/null 2>&1 || pip install --quiet pip-audit
	cd apps/ai-worker && uv pip compile pyproject.toml -o /tmp/sf-ai-req.txt 2>/dev/null || true
	@test -s /tmp/sf-ai-req.txt && pip-audit -r /tmp/sf-ai-req.txt --disable-pip || echo "  (no compiled requirements; skipping)"

up: ## Start core dev infra (postgres, redis, minio, meilisearch, chroma)
	docker compose up -d

up-ai: ## Start core + Ollama (~3 GB pull, needed for local-model fallback)
	docker compose --profile local-ai up -d

up-full: ## Start core + Ollama + ClamAV (everything)
	docker compose --profile local-ai --profile malware up -d

down: ## Stop dev infra
	docker compose --profile local-ai --profile malware down

logs: ## Tail dev infra logs
	docker compose logs -f --tail=100

ps: ## Show dev infra status
	docker compose ps

dev: ## Run all apps in dev mode (parallel)
	pnpm dev

web: ## Run only the web app
	pnpm --filter web dev

api: ## Run only the api gateway
	pnpm --filter api dev

ai-worker: ## Run only the ai-worker
	cd apps/ai-worker && uv run uvicorn src.main:app --reload --port 8001

fmt: ## Format all files
	pnpm format

lint: ## Lint all packages
	pnpm lint

typecheck: ## Typecheck all packages
	pnpm typecheck

test: ## Run all tests
	pnpm test

build: ## Build all packages
	pnpm build

psql: ## Open psql against dev db
	docker compose exec postgres psql -U studyforge -d studyforge

redis-cli: ## Open redis-cli against dev redis
	docker compose exec redis redis-cli

db-migrate: ## Apply Prisma migrations
	pnpm --filter api exec prisma migrate dev --name init

db-setup: ## Apply migrations + supplemental SQL (extensions, RLS, hash chain, vector indexes)
	pnpm --filter api exec prisma migrate deploy
	@for f in apps/api/prisma/sql/[0-9]*.sql; do \
	  echo "applying $$f"; \
	  docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U studyforge -d studyforge < $$f; \
	done

db-reset: ## Drop and recreate the dev db (DESTRUCTIVE)
	pnpm --filter api exec prisma migrate reset --force

prisma-studio: ## Open Prisma Studio
	pnpm --filter api exec prisma studio

clean: ## Remove all build artifacts
	pnpm clean

reset: ## Full reset (DESTRUCTIVE: removes containers + volumes + node_modules)
	docker compose down -v
	rm -rf node_modules apps/*/node_modules packages/*/node_modules
	rm -rf apps/*/dist apps/*/.next packages/*/dist .turbo
