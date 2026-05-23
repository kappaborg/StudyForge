"""IdentityReranker — preserves fused order, slices to top_k."""

from __future__ import annotations

import pytest

from src.rag.contracts import RetrievedChunk
from src.rag.reranker import IdentityReranker


def _chunk(chunk_id: str, score: float = 0.5) -> RetrievedChunk:
    return RetrievedChunk(
        chunk_id=chunk_id,
        doc_id="d1",
        version_id="v1",
        page=1,
        char_start=0,
        char_end=10,
        score=score,
        content=f"content for {chunk_id}",
    )


@pytest.mark.asyncio
async def test_identity_returns_empty_for_empty_input() -> None:
    out = await IdentityReranker().rerank(query="q", chunks=[], top_k=5)
    assert out == []


@pytest.mark.asyncio
async def test_identity_preserves_input_order() -> None:
    chunks = [_chunk("a"), _chunk("b"), _chunk("c")]
    out = await IdentityReranker().rerank(query="q", chunks=chunks, top_k=5)
    assert [c.chunk_id for c in out] == ["a", "b", "c"]


@pytest.mark.asyncio
async def test_identity_slices_to_top_k() -> None:
    chunks = [_chunk(str(i)) for i in range(10)]
    out = await IdentityReranker().rerank(query="q", chunks=chunks, top_k=3)
    assert [c.chunk_id for c in out] == ["0", "1", "2"]
