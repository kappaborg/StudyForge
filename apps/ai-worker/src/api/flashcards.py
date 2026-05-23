"""POST /v1/flashcards/generate — retrieve + run FlashcardAgent in one call.

Same shape as ``api/tutor.py``: build a Retriever bound to the Postgres
backends, fetch top-K chunks, hand them to the agent, return the deck.
The Nest gateway proxies this so the FE never talks to the worker
directly.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException
from pgvector.psycopg import register_vector_async  # noqa: F401  (side-effect imported on demand)
from pydantic import BaseModel, ConfigDict, Field
from psycopg_pool import AsyncConnectionPool

from ..agents.contracts import (
    Citation,
    FlashcardFromChunksInput,
    FlashcardKind,
    RetrievedChunk as AgentChunk,
)
from ..agents.flashcard import FlashcardAgent
from ..rag.contracts import Candidate, MetadataFilter, RetrievalRequest
from ..rag.factory import is_stub_embedder
from ..rag.retriever import Embedder, Retriever
from ..rag.postgres import build_postgres_backends
from ..rag.reranker import IdentityReranker
from ._chunk_trim import trim_chunk_content

log = logging.getLogger(__name__)


class FlashcardGenerateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    tenant_id: str
    user_id: str
    course_id: str | None = None
    folder_id: str | None = None
    chapters: list[int] | None = None
    query: str = ""
    deck_size: int = Field(default=12, ge=1, le=50)


class FlashcardCitationDto(BaseModel):
    model_config = ConfigDict(extra="forbid")

    chunk_id: str
    doc_id: str
    page: int | None = None
    slide: int | None = None
    score: float


class FlashcardDto(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: FlashcardKind
    front: str
    back: str
    citations: list[FlashcardCitationDto]


class FlashcardGenerateResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    course_id: str
    deck_title: str
    flashcards: list[FlashcardDto]


class _NoOpDense:
    """Dense stand-in when the embedder is stub (or fastembed without
    a folder filter). Returns no candidates so RRF reduces to sparse."""

    async def search(self, **_: object) -> list[Candidate]:
        return []


def build_router(
    *, dsn: str, pool: AsyncConnectionPool, flashcard_agent: FlashcardAgent, embedder: Embedder
) -> APIRouter:
    router = APIRouter(prefix="/v1/flashcards", tags=["flashcards"])

    dense, sparse, resolver, _holder = build_postgres_backends(dsn)
    # embedder is injected by build_router caller
    dense_path: Any = _NoOpDense() if is_stub_embedder(embedder) else dense
    retriever = Retriever(
        embedder=embedder,
        dense=dense_path,
        sparse=sparse,
        reranker=IdentityReranker(),
        resolver=resolver,
    )

    @router.post("/generate", response_model=FlashcardGenerateResponse)
    async def generate(req: FlashcardGenerateRequest) -> FlashcardGenerateResponse:
        # Retrieve enough chunks to give the model material for ``deck_size``
        # cards. Empty query falls back to ``OR`` of stopword-pruned tokens
        # via the sparse path — which means an empty query still returns
        # broad coverage of the course corpus.
        try:
            retrieval = await retriever.retrieve(
                RetrievalRequest(
                    tenant_id=req.tenant_id,
                    course_id=req.course_id,
                    folder_id=req.folder_id,
                    chapters=req.chapters,
                    query=req.query or "concepts definitions key terms",
                    k=max(req.deck_size, 8),
                )
            )
        except Exception as exc:  # noqa: BLE001
            log.exception("flashcard.retrieval_failed")
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

        result = await flashcard_agent.run(
            FlashcardFromChunksInput(
                course_id=req.course_id or "00000000-0000-0000-0000-000000000000",
                tenant_id=req.tenant_id,
                user_id=req.user_id,
                query=req.query,
                deck_size=req.deck_size,
            ),
            retrieved_chunks=agent_chunks,
        )

        return FlashcardGenerateResponse(
            course_id=result.course_id,
            deck_title=result.deck_title,
            flashcards=[
                FlashcardDto(
                    kind=card.kind,
                    front=card.front,
                    back=card.back,
                    citations=[_citation_to_dto(c) for c in card.citations],
                )
                for card in result.flashcards
            ],
        )

    return router


def _citation_to_dto(c: Citation) -> FlashcardCitationDto:
    return FlashcardCitationDto(
        chunk_id=c.chunk_id,
        doc_id=c.doc_id,
        page=c.page,
        slide=c.slide,
        score=c.score,
    )
