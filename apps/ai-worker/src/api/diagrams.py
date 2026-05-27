"""POST /v1/diagrams/generate — retrieve + run DiagramAgent."""

from __future__ import annotations

import logging
from typing import Any, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict
from psycopg_pool import AsyncConnectionPool

from ..agents.contracts import (
    DiagramFromChunksInput,
    RetrievedChunk as AgentChunk,
)
from ..agents.diagram import DiagramAgent
from ..rag.contracts import Candidate, MetadataFilter, RetrievalRequest
from ..rag.factory import is_stub_embedder
from ..rag.retriever import Embedder, Retriever
from ..rag.postgres import build_postgres_backends
from ..rag.factory import build_reranker
from ._chunk_trim import trim_chunk_content

log = logging.getLogger(__name__)


class DiagramGenerateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    tenant_id: str
    user_id: str
    course_id: str | None = None
    folder_id: str | None = None
    chapters: list[int] | None = None
    allowed_folder_ids: list[str] | None = None
    query: str = ""
    kind: Literal["flowchart", "mindmap", "sequence"] = "flowchart"


class DiagramGenerateResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    course_id: str
    kind: str
    renderer: str
    source: str


class _NoOpDense:
    """Dense stand-in when the embedder is stub (or fastembed without
    a folder filter). Returns no candidates so RRF reduces to sparse."""

    async def search(self, **_: object) -> list[Candidate]:
        return []


def build_router(
    *, dsn: str, pool: AsyncConnectionPool, diagram_agent: DiagramAgent, embedder: Embedder
) -> APIRouter:
    router = APIRouter(prefix="/v1/diagrams", tags=["diagrams"])

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

    @router.post("/generate", response_model=DiagramGenerateResponse)
    async def generate(req: DiagramGenerateRequest) -> DiagramGenerateResponse:
        try:
            retrieval = await retriever.retrieve(
                RetrievalRequest(
                    tenant_id=req.tenant_id,
                    course_id=req.course_id,
                    folder_id=req.folder_id,
                    chapters=req.chapters,
                    allowed_folder_ids=req.allowed_folder_ids,
                    query=req.query or "key relationships pipeline process steps",
                    k=12,
                )
            )
        except Exception as exc:  # noqa: BLE001
            log.exception("diagram.retrieval_failed")
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

        result = await diagram_agent.run(
            DiagramFromChunksInput(
                course_id=req.course_id or "00000000-0000-0000-0000-000000000000",
                tenant_id=req.tenant_id,
                user_id=req.user_id,
                query=req.query,
                kind=req.kind,
            ),
            retrieved_chunks=agent_chunks,
        )

        return DiagramGenerateResponse(
            course_id=result.course_id,
            kind=req.kind,
            renderer=result.renderer,
            source=result.source,
        )

    return router
