"""POST /v1/tutor/stream — Server-Sent Events tutor.

Emits one event per LLM delta, ending with a ``citations`` event that
carries the validated citation list. The FE renders deltas as they
arrive (typewriter effect) and shows citations once the stream ends.

Citation enforcement is unchanged: we collect the full text and only
emit citations that pass the post-stream validation. If no citations
land, we emit a single ``refusal`` event and tell the FE to display
the refusal banner instead.
"""

from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from psycopg_pool import AsyncConnectionPool
from starlette.responses import StreamingResponse

from ..agents.contracts import RetrievedChunk as AgentChunk, TutorInput
from ..agents.tutor import (
    CITATION_TAG_RE,
    TUTOR_SYSTEM_PROMPT,
    TutorAgent,
    _extract_cited_chunk_ids,
    _strip_citation_tags,
)
from ..llm.contracts import (
    ChannelMessage as LLMChannelMessage,
    LLMRequest,
)
from ..rag.contracts import RetrievalRequest
from ..rag.factory import is_stub_embedder
from ..rag.postgres import build_postgres_backends
from ..rag.reranker import IdentityReranker
from ..rag.retriever import Embedder, Retriever
from ..safety.prompt_builder import build_messages
from ._chunk_trim import trim_chunk_content

log = logging.getLogger(__name__)


class TutorStreamRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    tenant_id: str
    user_id: str
    session_id: str = Field(default="00000000-0000-0000-0000-000000000000")
    course_id: str | None = None
    folder_id: str | None = None
    chapters: list[int] | None = None
    query: str = Field(min_length=1, max_length=8000)
    top_k: int = Field(default=5, ge=1, le=20)


class _NoOpDense:
    async def search(self, **_: object) -> list[Any]:
        return []


def _sse(event: str, data: object) -> bytes:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n".encode()


def build_router(
    *, dsn: str, pool: AsyncConnectionPool, tutor_agent: TutorAgent, embedder: Embedder
) -> APIRouter:
    router = APIRouter(prefix="/v1/tutor", tags=["tutor"])

    dense, sparse, resolver, _holder = build_postgres_backends(dsn)
    dense_path: Any = _NoOpDense() if is_stub_embedder(embedder) else dense
    retriever = Retriever(
        embedder=embedder,
        dense=dense_path,
        sparse=sparse,
        reranker=IdentityReranker(),
        resolver=resolver,
    )

    @router.post("/stream")
    async def stream(req: TutorStreamRequest) -> StreamingResponse:
        if tutor_agent._provider is None:
            raise HTTPException(
                status_code=503,
                detail="No LLM provider configured. Set GROQ_API_KEY for streaming.",
            )
        return StreamingResponse(
            _emit(req, retriever, tutor_agent),
            media_type="text/event-stream",
            headers={
                "cache-control": "no-cache",
                "x-accel-buffering": "no",
            },
        )

    return router


async def _emit(
    req: TutorStreamRequest,
    retriever: Retriever,
    tutor_agent: TutorAgent,
) -> AsyncIterator[bytes]:
    # 1. Retrieve. Send a single ``meta`` event up front so the FE can
    #    render a "thinking…" indicator with the chunk count.
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
        yield _sse("error", {"message": f"retrieval failed: {exc}"})
        return

    supportive_chunks = [
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
    yield _sse("meta", {"retrievedChunkCount": len(supportive_chunks)})
    if not supportive_chunks:
        yield _sse(
            "refusal",
            {
                "text": "I could not find this in your uploaded materials.",
                "reason": "no-chunks",
            },
        )
        yield _sse("done", {})
        return

    # 2. Build the prompt + stream deltas. Buffer the full text so we can
    #    run citation validation when the stream completes.
    messages = build_messages(
        system_prompt=TUTOR_SYSTEM_PROMPT,
        user_query=req.query,
        retrieved_chunks=supportive_chunks,
    )
    llm_messages = [LLMChannelMessage(role=m.role, content=m.content) for m in messages]
    provider = tutor_agent._provider
    assert provider is not None

    full_text = ""
    try:
        async for delta_chunk in provider.stream(
            LLMRequest(
                model=tutor_agent._model,
                messages=llm_messages,
                max_output_tokens=tutor_agent._max_output_tokens,
                temperature=tutor_agent._temperature,
                stream=True,
                user=req.user_id,
                cache_prefix_boundary=1,
            )
        ):
            if delta_chunk.delta:
                full_text += delta_chunk.delta
                # Strip any citation tag fragments from the delta so the
                # rendered text stays clean. The full untrimmed buffer
                # remains for the post-stream citation extraction.
                clean_delta = CITATION_TAG_RE.sub("", delta_chunk.delta)
                if clean_delta:
                    yield _sse("delta", {"text": clean_delta})
            if delta_chunk.done:
                break
    except Exception as exc:  # noqa: BLE001
        yield _sse("error", {"message": f"llm stream failed: {exc}"})
        return

    # 3. Post-stream citation validation. Same contract as the synchronous
    #    tutor endpoint — drop tags that don't map to a supportive chunk.
    cited_ids = _extract_cited_chunk_ids(full_text)
    supportive_index = {c.chunk_id: c for c in supportive_chunks}
    valid_citations = []
    for cid in cited_ids:
        source = supportive_index.get(cid)
        if source is None:
            continue
        valid_citations.append(
            {
                "chunkId": source.chunk_id,
                "docId": source.doc_id,
                "page": source.page,
                "score": source.score,
            }
        )

    if not valid_citations:
        yield _sse(
            "refusal",
            {
                "text": "I could not produce a citation-grounded answer for this question.",
                "reason": "no-citations",
            },
        )
    else:
        yield _sse("citations", {"citations": valid_citations})
    yield _sse("done", {"text": _strip_citation_tags(full_text).strip()})


# Re-export for the TutorInput conversion site if a future consumer needs it.
__all__ = ["build_router", "TutorStreamRequest"]

# Touch TutorInput so mypy keeps the import for future use (the underscore
# private symbols above are stable from agents.tutor).
_ = TutorInput
