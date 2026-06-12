"""POST /v1/roadmaps/generate — retrieve + run RoadmapAgent in one call."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException
from psycopg_pool import AsyncConnectionPool
from pydantic import BaseModel, ConfigDict, Field

from ..agents.contracts import (
    RetrievedChunk as AgentChunk,
)
from ..agents.contracts import (
    RoadmapFromChunksInput,
)
from ..agents.roadmap import RoadmapAgent
from ..rag.contracts import Candidate, RetrievalRequest
from ..rag.factory import build_reranker, is_stub_embedder
from ..rag.postgres import build_postgres_backends
from ..rag.retriever import Embedder, Retriever
from ._chunk_trim import trim_chunk_content

log = logging.getLogger(__name__)


class RoadmapGenerateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    tenant_id: str
    user_id: str
    course_id: str | None = None
    folder_id: str | None = None
    chapters: list[int] | None = None
    allowed_folder_ids: list[str] | None = None
    query: str = ""
    weeks: int = Field(default=4, ge=1, le=16)


class MilestoneDto(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str
    week_index: int
    ordinal: int
    effort_min: int


class RoadmapGenerateResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    course_id: str
    title: str
    weeks: int
    milestones: list[MilestoneDto]


class _NoOpDense:
    """Dense stand-in when the embedder is stub (or fastembed without
    a folder filter). Returns no candidates so RRF reduces to sparse."""

    async def search(self, **_: object) -> list[Candidate]:
        return []


def build_router(
    *, dsn: str, pool: AsyncConnectionPool, roadmap_agent: RoadmapAgent, embedder: Embedder
) -> APIRouter:
    router = APIRouter(prefix="/v1/roadmaps", tags=["roadmaps"])

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

    @router.post("/generate", response_model=RoadmapGenerateResponse)
    async def generate(req: RoadmapGenerateRequest) -> RoadmapGenerateResponse:
        try:
            retrieval = await retriever.retrieve(
                RetrievalRequest(
                    tenant_id=req.tenant_id,
                    course_id=req.course_id,
                    folder_id=req.folder_id,
                    chapters=req.chapters,
                    allowed_folder_ids=req.allowed_folder_ids,
                    query=req.query or "syllabus topics outline learning objectives",
                    # Pull enough chunks to give 2-4 milestones per week.
                    k=max(req.weeks * 4, 12),
                )
            )
        except Exception as exc:
            log.exception("roadmap.retrieval_failed")
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

        result = await roadmap_agent.run(
            RoadmapFromChunksInput(
                course_id=req.course_id or "00000000-0000-0000-0000-000000000000",
                tenant_id=req.tenant_id,
                user_id=req.user_id,
                query=req.query,
                weeks=req.weeks,
            ),
            retrieved_chunks=agent_chunks,
        )

        return RoadmapGenerateResponse(
            course_id=result.course_id,
            title=result.title,
            weeks=result.weeks,
            milestones=[
                MilestoneDto(
                    title=m.title,
                    week_index=m.week_index,
                    ordinal=m.ordinal,
                    effort_min=m.effort_min,
                )
                for m in result.milestones
            ],
        )

    return router
