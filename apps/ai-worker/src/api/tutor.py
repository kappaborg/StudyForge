"""POST /v1/tutor/ask — retrieve + run TutorAgent in one HTTP call.

The gateway calls this with a question + tenant; the worker owns the
retrieval-then-tutor stitching so the gateway never needs to know about
RAG internals. Same code path the orchestrator would use; this endpoint
just elides the run-state-machine bookkeeping for the synchronous user-
facing case.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from psycopg_pool import AsyncConnectionPool

from ..agents.contracts import RetrievedChunk as AgentChunk, TutorInput
from ..agents.tutor import TutorAgent
from ..rag.contracts import Candidate, MetadataFilter, RetrievalRequest
from ..rag.contracts import RetrievedChunk as RagChunk
from ..rag.factory import is_stub_embedder
from ..rag.retriever import Embedder, Retriever
from ..rag.postgres import build_postgres_backends
from ..rag.reranker import IdentityReranker
from ._chunk_trim import trim_chunk_content


class _NoOpDense:
    """Dense stand-in when the embedder is stub (or fastembed without
    a folder filter). Returns no candidates so RRF reduces to sparse."""

    async def search(self, **_: object) -> list[Candidate]:
        return []

log = logging.getLogger(__name__)


class TutorAskRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    tenant_id: str
    user_id: str
    session_id: str = Field(default="00000000-0000-0000-0000-000000000000")
    course_id: str | None = None
    folder_id: str | None = None
    chapters: list[int] | None = None
    query: str = Field(min_length=1, max_length=8000)
    top_k: int = Field(default=5, ge=1, le=20)


class TutorAskCitation(BaseModel):
    model_config = ConfigDict(extra="forbid")

    chunk_id: str
    doc_id: str
    page: int | None = None
    score: float


class TutorAskResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    refusal: bool
    text: str
    citations: list[TutorAskCitation]
    suggestions: list[str]
    retrieved_chunk_count: int


def build_router(*, dsn: str, pool: AsyncConnectionPool, tutor_agent: TutorAgent, embedder: Embedder) -> APIRouter:
    router = APIRouter(prefix="/v1/tutor", tags=["tutor"])

    # Lazy-build the retriever the first time the endpoint fires. Pool is
    # already open by lifespan().
    dense, sparse, resolver, _holder = build_postgres_backends(dsn)

    # embedder is injected by build_router caller
    # Stub embedder produces hash-based vectors — its dense ANN matches are
    # effectively random and would dilute the sparse signal at RRF time.
    # Swap dense for a no-op until BGE-M3 is wired.
    dense_path: Any = _NoOpDense() if is_stub_embedder(embedder) else dense
    retriever = Retriever(
        embedder=embedder,
        dense=dense_path,
        sparse=sparse,
        reranker=IdentityReranker(),
        resolver=resolver,
    )

    @router.post("/ask", response_model=TutorAskResponse)
    async def ask(req: TutorAskRequest) -> TutorAskResponse:
        try:
            retrieval = await retriever.retrieve(
                RetrievalRequest(
                    tenant_id=req.tenant_id,
                    course_id=req.course_id,
                    folder_id=req.folder_id,
                    chapters=req.chapters,
                    query=req.query,
                    k=req.top_k,
                )
            )
        except Exception as exc:  # noqa: BLE001
            log.exception("retrieval failed")
            raise HTTPException(status_code=502, detail=f"retrieval failed: {exc}") from exc

        chunks: list[RagChunk] = retrieval.chunks
        # The agent's RetrievedChunk type forbids the ``modality`` /
        # ``heading_path`` extras the RAG type carries. Translate explicitly so
        # ``extra="forbid"`` validation passes.
        agent_chunks = [
            AgentChunk(
                chunk_id=c.chunk_id,
                doc_id=c.doc_id,
                version_id=c.version_id,
                page=c.page,
                slide=c.slide,
                cell=c.cell,
                char_start=c.char_start,
                char_end=c.char_end,
                score=c.score,
                content=trim_chunk_content(c.content),
            )
            for c in chunks
        ]

        result = await tutor_agent.run(
            TutorInput(
                session_id=req.session_id,
                user_id=req.user_id,
                tenant_id=req.tenant_id,
                course_id=req.course_id,
                query=req.query,
                retrieved_chunks=agent_chunks,
            )
        )

        return TutorAskResponse(
            refusal=result.refusal,
            text=result.text,
            citations=[
                TutorAskCitation(
                    chunk_id=c.chunk_id,
                    doc_id=c.doc_id,
                    page=c.page,
                    score=c.score,
                )
                for c in result.citations
            ],
            suggestions=list(result.suggestions),
            retrieved_chunk_count=len(chunks),
        )

    @router.get("/_diagnose")
    async def diagnose() -> dict[str, Any]:
        """Quick sanity probe — counts in the DB scoped to a tenant header."""
        async with pool.connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    'SELECT count(*) FROM "Document" WHERE "deletedAt" IS NULL'
                )
                doc_count = (await cur.fetchone() or (0,))[0]
                await cur.execute(
                    'SELECT count(*) FROM "Chunk" WHERE embedding IS NOT NULL'
                )
                embedded_count = (await cur.fetchone() or (0,))[0]
        return {"documents": doc_count, "embedded_chunks": embedded_count}

    return router
