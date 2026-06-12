"""POST /v1/presentations/generate — retrieve + run PresentationAgent."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException
from psycopg_pool import AsyncConnectionPool
from pydantic import BaseModel, ConfigDict, Field

from ..agents.contracts import RetrievedChunk as AgentChunk
from ..agents.presentation import PresentationAgent, PresentationFromChunksInput
from ..rag.contracts import Candidate, RetrievalRequest
from ..rag.factory import build_reranker, is_stub_embedder
from ..rag.postgres import build_postgres_backends
from ..rag.retriever import Embedder, Retriever
from ._chunk_trim import trim_chunk_content

log = logging.getLogger(__name__)


class PresentationGenerateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    tenant_id: str
    user_id: str
    course_id: str | None = None
    folder_id: str | None = None
    chapters: list[int] | None = None
    allowed_folder_ids: list[str] | None = None
    query: str = ""
    slide_count: int = Field(default=8, ge=4, le=20)


class PresentationGenerateResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    course_id: str
    title: str
    markdown: str
    slide_count: int


class _NoOpDense:
    """Dense stand-in when the embedder is stub (or fastembed without
    a folder filter). Returns no candidates so RRF reduces to sparse."""

    async def search(self, **_: object) -> list[Candidate]:
        return []


def build_router(
    *, dsn: str, pool: AsyncConnectionPool, presentation_agent: PresentationAgent, embedder: Embedder
) -> APIRouter:
    router = APIRouter(prefix="/v1/presentations", tags=["presentations"])

    dense, sparse, resolver, _holder = build_postgres_backends(dsn)
    # embedder is injected by build_router caller
    dense_path: Any = _NoOpDense() if is_stub_embedder(embedder) else dense
    retriever = Retriever(
        embedder=embedder,
        dense=dense_path,
        sparse=sparse,
        reranker=build_reranker(),
        resolver=resolver,
    )

    @router.post("/generate", response_model=PresentationGenerateResponse)
    async def generate(req: PresentationGenerateRequest) -> PresentationGenerateResponse:
        try:
            retrieval = await retriever.retrieve(
                RetrievalRequest(
                    tenant_id=req.tenant_id,
                    course_id=req.course_id,
                    folder_id=req.folder_id,
                    chapters=req.chapters,
                    allowed_folder_ids=req.allowed_folder_ids,
                    query=req.query or "key sections outline summary",
                    k=max(req.slide_count, 10),
                )
            )
        except Exception as exc:
            log.exception("presentation.retrieval_failed")
            raise HTTPException(status_code=502, detail=f"retrieval failed: {exc}") from exc

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
            for c in retrieval.chunks
        ]

        result = await presentation_agent.run(
            PresentationFromChunksInput(
                course_id=req.course_id or "00000000-0000-0000-0000-000000000000",
                tenant_id=req.tenant_id,
                user_id=req.user_id,
                query=req.query,
                slide_count=req.slide_count,
            ),
            retrieved_chunks=agent_chunks,
        )

        return PresentationGenerateResponse(
            course_id=result.course_id,
            title=result.title,
            markdown=result.markdown,
            slide_count=result.slide_count,
        )

    return router
