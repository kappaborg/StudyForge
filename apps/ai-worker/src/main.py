from __future__ import annotations

# Observability must initialise BEFORE any framework module is imported
# so OTel can hook the FastAPI / httpx instrumentations. Opt-in only —
# no-op when ``OTEL_EXPORTER_OTLP_ENDPOINT`` / ``SENTRY_DSN`` are unset.
from .observability import setup_observability

setup_observability()

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime

import structlog
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .agents import registry as agent_registry
from .agents.diagram import DiagramAgent
from .agents.flashcard import FlashcardAgent
from .agents.ingest_agent import build_default_ingest_agent
from .agents.presentation import PresentationAgent
from .agents.quiz import QuizAgent
from .agents.roadmap import RoadmapAgent
from .agents.semantic import SemanticAnalyzerAgent
from .agents.tutor import TutorAgent
from .api.admin import build_router as build_admin_router
from .api.deep_index import build_router as build_deep_index_router
from .api.diagrams import build_router as build_diagrams_router
from .api.exam_scopes import build_router as build_exam_scopes_router
from .api.flashcards import build_router as build_flashcards_router
from .api.ingest_url import build_router as build_ingest_url_router
from .api.presentations import build_router as build_presentations_router
from .api.quizzes import build_router as build_quizzes_router
from .api.roadmaps import build_router as build_roadmaps_router
from .api.runs import build_router as build_runs_router
from .api.semantic import build_router as build_semantic_router
from .api.tutor import build_router as build_tutor_router
from .api.tutor_stream import build_router as build_tutor_stream_router
from .llm.contracts import LLMProvider
from .llm.registry import ProviderCredentials, ProviderRegistry
from .orchestrator import (
    InMemoryRunStore,
    Orchestrator,
    PostgresRunStore,
    RunStore,
)
from .settings import get_settings

settings = get_settings()


# Provider wiring. Builds a registry of every adapter for which a key is
# present in the environment, then exposes the §13.1 free-tier-preferred
# adapter as ``tutor_provider``. When no provider is configured the tutor
# falls back to its labelled stub path so dev runs still work.
provider_registry = ProviderRegistry(
    ProviderCredentials(
        groq_api_key=settings.groq_api_key,
        openai_api_key=settings.openai_api_key,
        anthropic_api_key=settings.anthropic_api_key,
        openrouter_api_key=settings.openrouter_api_key,
        cerebras_api_key=settings.cerebras_api_key,
        together_api_key=settings.together_api_key,
        fireworks_api_key=settings.fireworks_api_key,
        # Ollama auto-registers when the base URL is reachable. We don't
        # probe at boot — too slow on cold start — so this flag is for now
        # opt-in via env. Phase B-2 adds a real reachability probe.
        enable_ollama=False,
        ollama_base_url=settings.ollama_base_url,
    )
)


def _build_default_provider() -> LLMProvider | None:
    return provider_registry.preferred_free_provider()


tutor_provider = _build_default_provider()
tutor_agent = TutorAgent(provider=tutor_provider)
agent_registry.register(tutor_agent)

# Flashcard + Quiz agents aren't registered in the orchestrator — they
# consume pre-retrieved chunks alongside the input, so they don't fit the
# single-payload ``Agent`` protocol. Their HTTP routers wire retrieval + run.
flashcard_agent = FlashcardAgent(provider=tutor_provider)
quiz_agent = QuizAgent(provider=tutor_provider)
roadmap_agent = RoadmapAgent(provider=tutor_provider)
semantic_agent = SemanticAnalyzerAgent(provider=tutor_provider)
diagram_agent = DiagramAgent(provider=tutor_provider)
presentation_agent = PresentationAgent(provider=tutor_provider)


# Orchestrator wiring. Postgres-backed store when ``ORCHESTRATOR_STORE=postgres``
# (the default for dev + prod); in-memory fallback for tests and CI runs that
# don't have a database. The pool is opened lazily on first store touch.
_run_pool: object | None = None


def _build_run_store() -> RunStore:
    global _run_pool
    mode = (settings.environment or "development").lower()
    use_postgres = (
        # Explicit opt-in
        getattr(settings, "orchestrator_store", "") == "postgres"
        # Or implicit when DATABASE_URL points somewhere and we're not in CI
        or (settings.database_url and mode != "test")
    )
    if not use_postgres:
        return InMemoryRunStore()
    from psycopg_pool import AsyncConnectionPool

    pool = AsyncConnectionPool(
        settings.database_url,
        min_size=1,
        max_size=4,
        open=False,
    )
    _run_pool = pool
    return PostgresRunStore(pool)


run_store = _build_run_store()
orchestrator = Orchestrator(store=run_store, registry=agent_registry)


# Register the ingest agent. Needs the orchestrator's pool to run the embed
# writer; only available when ``_run_pool`` is set (i.e. Postgres mode).
if _run_pool is not None:
    agent_registry.register(
        build_default_ingest_agent(settings, _run_pool)  # type: ignore[arg-type]
    )

logging.basicConfig(level=settings.log_level.upper())
structlog.configure(
    processors=[
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.JSONRenderer(),
    ]
)
log = structlog.get_logger("ai-worker")


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    log.info(
        "ai-worker.startup",
        environment=settings.environment,
        run_store=type(run_store).__name__,
    )
    if _run_pool is not None:
        await _run_pool.open()  # type: ignore[attr-defined]
    try:
        yield
    finally:
        if _run_pool is not None:
            await _run_pool.close()  # type: ignore[attr-defined]
        log.info("ai-worker.shutdown")


app = FastAPI(
    title="StudyForge AI Worker",
    version="0.1.0",
    description="FastAPI service for parsing, embedding, and AI generation tasks.",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(build_runs_router(orchestrator, agent_registry))

# Exam-scope parser is RAG-free + pool-free, so it always loads.
app.include_router(build_exam_scopes_router())

# One embedder for every RAG-using route. ``EMBEDDER_BACKEND=fastembed``
# in the worker .env flips dense retrieval from no-op (stub vectors) to
# real ONNX bge-large-en-v1.5. See ``rag/factory.py``.
from .rag.factory import build_embedder

embedder = build_embedder(settings)
log.info("ai-worker.embedder", backend=type(embedder).__name__)

# Tutor synchronous-ask endpoint. Lifespan-bound: requires the same Postgres
# pool used by the orchestrator run store.
if _run_pool is not None:
    app.include_router(
        build_tutor_router(
            dsn=settings.database_url,
            pool=_run_pool,  # type: ignore[arg-type]
            tutor_agent=tutor_agent,
            embedder=embedder,
        )
    )
    app.include_router(
        build_tutor_stream_router(
            dsn=settings.database_url,
            pool=_run_pool,  # type: ignore[arg-type]
            tutor_agent=tutor_agent,
            embedder=embedder,
        )
    )
    app.include_router(
        build_flashcards_router(
            dsn=settings.database_url,
            pool=_run_pool,  # type: ignore[arg-type]
            flashcard_agent=flashcard_agent,
            embedder=embedder,
        )
    )
    app.include_router(
        build_quizzes_router(
            dsn=settings.database_url,
            pool=_run_pool,  # type: ignore[arg-type]
            quiz_agent=quiz_agent,
            embedder=embedder,
        )
    )
    app.include_router(
        build_roadmaps_router(
            dsn=settings.database_url,
            pool=_run_pool,  # type: ignore[arg-type]
            roadmap_agent=roadmap_agent,
            embedder=embedder,
        )
    )
    app.include_router(
        build_semantic_router(
            dsn=settings.database_url,
            pool=_run_pool,  # type: ignore[arg-type]
            semantic_agent=semantic_agent,
            embedder=embedder,
        )
    )
    app.include_router(
        build_diagrams_router(
            dsn=settings.database_url,
            pool=_run_pool,  # type: ignore[arg-type]
            diagram_agent=diagram_agent,
            embedder=embedder,
        )
    )
    app.include_router(
        build_presentations_router(
            dsn=settings.database_url,
            pool=_run_pool,  # type: ignore[arg-type]
            presentation_agent=presentation_agent,
            embedder=embedder,
        )
    )
    app.include_router(
        build_admin_router(
            pool=_run_pool,  # type: ignore[arg-type]
            embedder=embedder,
        )
    )
    app.include_router(
        build_ingest_url_router(
            dsn=settings.database_url,
            pool=_run_pool,  # type: ignore[arg-type]
            embedder=embedder,
        )
    )
    # Deep-index uses whatever LLM provider is configured. We only know
    # about Groq today; the lookup helper makes it trivial to plug in the
    # full ProviderRegistry later without touching the endpoint.
    def _get_provider(provider_id: str) -> LLMProvider | None:
        if provider_id == "groq":
            return tutor_provider
        return None
    app.include_router(
        build_deep_index_router(
            pool=_run_pool,  # type: ignore[arg-type]
            get_provider=_get_provider,
        )
    )


@app.get("/health", tags=["health"])
def health() -> dict[str, str]:
    return {
        "status": "ok",
        "service": "ai-worker",
        "ts": datetime.now(UTC).isoformat(),
    }


@app.get("/ready", tags=["health"])
def ready() -> dict[str, str]:
    return {
        "status": "ok",
        "service": "ai-worker",
        "ts": datetime.now(UTC).isoformat(),
    }
