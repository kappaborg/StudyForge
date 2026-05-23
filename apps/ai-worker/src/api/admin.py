"""Worker-side admin endpoints. Dev/ops-only — wired behind the Nest
gateway so the public API surface stays clean.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict
from psycopg_pool import AsyncConnectionPool

from ..rag.embed_writer import embed_pending_chunks
from ..rag.retriever import Embedder

log = logging.getLogger(__name__)


class ReembedResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    chunks_embedded: int
    batches: int


def build_router(*, pool: AsyncConnectionPool, embedder: Embedder) -> APIRouter:
    router = APIRouter(prefix="/v1/admin", tags=["admin"])

    @router.post("/reembed", response_model=ReembedResponse)
    async def reembed() -> ReembedResponse:
        """Wipe ``Chunk.embedding`` for every chunk + re-run the writer.

        Necessary after flipping ``EMBEDDER_BACKEND``: existing rows hold
        vectors from the old backend (e.g. StubEmbedder's hash output)
        and would land in a different vector space than fresh queries.
        """
        async with pool.connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute('UPDATE "Chunk" SET embedding = NULL')
                wiped = cur.rowcount
        log.info("admin.reembed wiped=%d", wiped)
        outcome = await embed_pending_chunks(pool=pool, embedder=embedder)
        return ReembedResponse(
            chunks_embedded=outcome.chunks_embedded,
            batches=outcome.batches,
        )

    return router
