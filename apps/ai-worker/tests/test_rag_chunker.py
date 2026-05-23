"""Chunker — structural boundaries must be preserved.

Crossing a slide/cell/heading boundary makes the citation uncitable. These
tests pin that property in the design rather than trust the implementation
to stay correct under future edits.
"""

from __future__ import annotations

from src.agents.contracts import Block, ChunkModality
from src.rag.chunker import ChunkerDispatcher, TextChunker


def test_text_chunker_preserves_heading_path() -> None:
    block = Block(
        modality=ChunkModality.text,
        text=(
            "# Linear Algebra\n"
            "## Vectors\n"
            "A vector is an ordered tuple of numbers. "
            "Vectors can be added componentwise.\n"
            "## Matrices\n"
            "A matrix is a rectangular array of numbers. "
            "Matrix multiplication is not commutative.\n"
        ),
        char_start=0,
    )
    out = TextChunker().chunk(block, starting_ordinal=0)
    assert out, "expected at least one chunk"
    # Heading paths must be carried.
    headings = {tuple(c.heading_path) for c in out}
    assert ("Linear Algebra", "Vectors") in headings
    assert ("Linear Algebra", "Matrices") in headings
    # Heading boundaries are NEVER spanned — no chunk text from "Vectors"
    # appears in a chunk whose path resolves to "Matrices".
    for chunk in out:
        if chunk.heading_path[-1:] == ("Vectors",):
            assert "matrix" not in chunk.content.lower()
        if chunk.heading_path[-1:] == ("Matrices",):
            assert "vector is an ordered tuple" not in chunk.content.lower()


def test_text_chunker_returns_empty_for_blank_blocks() -> None:
    block = Block(modality=ChunkModality.text, text="   \n   ")
    assert TextChunker().chunk(block, starting_ordinal=0) == []


def test_dispatcher_one_chunk_per_slide() -> None:
    blocks = [
        Block(modality=ChunkModality.slide, text="Slide 1 content", slide=1, char_start=0),
        Block(modality=ChunkModality.slide, text="Slide 2 content", slide=2, char_start=100),
        # Empty slide is dropped.
        Block(modality=ChunkModality.slide, text="   ", slide=3, char_start=200),
    ]
    out = ChunkerDispatcher().chunk_blocks(blocks)
    assert [c.ordinal for c in out] == [0, 1]
    assert [c.slide for c in out] == [1, 2]
    # Slide boundaries are preserved (one chunk per non-empty slide).
    assert all(c.modality == ChunkModality.slide for c in out)
