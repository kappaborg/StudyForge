"""POST /v1/semantic/analyze — retrieve + run SemanticAnalyzerAgent."""

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
    SemanticAnalyzerFromChunksInput,
)
from ..agents.semantic import SemanticAnalyzerAgent
from ..rag.contracts import Candidate, RetrievalRequest
from ..rag.factory import build_reranker, is_stub_embedder
from ..rag.postgres import build_postgres_backends
from ..rag.retriever import Embedder, Retriever
from ._chunk_trim import trim_chunk_content

log = logging.getLogger(__name__)


class SemanticAnalyzeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    tenant_id: str
    user_id: str
    course_id: str | None = None
    folder_id: str | None = None
    chapters: list[int] | None = None
    allowed_folder_ids: list[str] | None = None
    max_concepts: int = Field(default=12, ge=3, le=40)


class ConceptDto(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    label: str
    description: str | None = None
    difficulty: int
    chunk_ids: list[str]


class ConceptEdgeDto(BaseModel):
    model_config = ConfigDict(extra="forbid")

    from_id: str
    to_id: str
    kind: str
    weight: float


class SemanticAnalyzeResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    course_id: str
    concepts: list[ConceptDto]
    edges: list[ConceptEdgeDto]


class _NoOpDense:
    """Dense stand-in when the embedder is stub (or fastembed without
    a folder filter). Returns no candidates so RRF reduces to sparse."""

    async def search(self, **_: object) -> list[Candidate]:
        return []


def build_router(
    *, dsn: str, pool: AsyncConnectionPool, semantic_agent: SemanticAnalyzerAgent, embedder: Embedder
) -> APIRouter:
    router = APIRouter(prefix="/v1/semantic", tags=["semantic"])

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

    @router.post("/analyze", response_model=SemanticAnalyzeResponse)
    async def analyze(req: SemanticAnalyzeRequest) -> SemanticAnalyzeResponse:
        try:
            # Pull broad coverage. Concept extraction reads the corpus
            # holistically, so we ask for more chunks than the generation
            # agents do.
            retrieval = await retriever.retrieve(
                RetrievalRequest(
                    tenant_id=req.tenant_id,
                    course_id=req.course_id,
                    folder_id=req.folder_id,
                    chapters=req.chapters,
                    allowed_folder_ids=req.allowed_folder_ids,
                    query="key concepts topics terms definitions",
                    k=min(req.max_concepts * 3, 60),
                )
            )
        except Exception as exc:
            log.exception("semantic.retrieval_failed")
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

        result = await semantic_agent.run(
            SemanticAnalyzerFromChunksInput(
                course_id=req.course_id or "00000000-0000-0000-0000-000000000000",
                tenant_id=req.tenant_id,
                user_id=req.user_id,
                max_concepts=req.max_concepts,
            ),
            retrieved_chunks=agent_chunks,
        )

        # Fold the parallel ``refs`` collection back into per-concept
        # ``chunk_ids`` so the API only has to ferry one DTO list.
        chunk_ids_by_concept = {ref.concept_id: ref.chunk_ids for ref in result.refs}
        concepts = [
            ConceptDto(
                id=c.id,
                label=c.label,
                description=c.description,
                difficulty=c.difficulty,
                chunk_ids=chunk_ids_by_concept.get(c.id, []),
            )
            for c in result.concepts
        ]
        edges = [
            ConceptEdgeDto(
                from_id=e.from_id,
                to_id=e.to_id,
                kind=e.kind.value,
                weight=e.weight,
            )
            for e in result.edges
        ]
        return SemanticAnalyzeResponse(
            course_id=result.course_id,
            concepts=concepts,
            edges=edges,
        )

    return router
