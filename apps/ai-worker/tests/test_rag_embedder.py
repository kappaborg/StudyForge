"""StubEmbedder — deterministic, unit-norm, dim-correct."""

from __future__ import annotations

import math

import pytest

from src.rag.embedder import EMBEDDING_DIM, StubEmbedder


@pytest.mark.asyncio
async def test_stub_embedder_returns_correct_dimension() -> None:
    e = StubEmbedder()
    v = await e.embed_query("hello world")
    assert len(v) == EMBEDDING_DIM


@pytest.mark.asyncio
async def test_stub_embedder_is_deterministic() -> None:
    e = StubEmbedder()
    a = await e.embed_query("gradient descent")
    b = await e.embed_query("gradient descent")
    assert a == b


@pytest.mark.asyncio
async def test_stub_embedder_distinguishes_inputs() -> None:
    e = StubEmbedder()
    a = await e.embed_query("apple")
    b = await e.embed_query("orange")
    # Cosine similarity should be far from 1 for unrelated strings.
    similarity = sum(x * y for x, y in zip(a, b, strict=True))
    assert similarity < 0.9


@pytest.mark.asyncio
async def test_stub_embedder_produces_unit_vectors() -> None:
    e = StubEmbedder()
    v = await e.embed_query("anything")
    norm = math.sqrt(sum(x * x for x in v))
    assert math.isclose(norm, 1.0, abs_tol=1e-9)


@pytest.mark.asyncio
async def test_stub_embedder_handles_passage_batches() -> None:
    e = StubEmbedder()
    vs = await e.embed_passages(["a", "b", "c"])
    assert len(vs) == 3
    assert all(len(v) == EMBEDDING_DIM for v in vs)
    assert vs[0] != vs[1]
