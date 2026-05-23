"""PDF parser — one Block per non-empty page, page numbers preserved."""

from __future__ import annotations

import fitz
import pytest

from src.agents.contracts import ChunkModality
from src.ingest.pdf import parse_pdf


def _make_pdf(pages: list[str]) -> bytes:
    """Build a tiny multi-page PDF in memory from a list of page strings."""
    doc = fitz.open()
    for body in pages:
        page = doc.new_page()
        page.insert_text((72, 72), body)
    pdf_bytes = doc.tobytes()
    doc.close()
    return pdf_bytes


def test_parse_pdf_returns_empty_for_empty_input() -> None:
    assert parse_pdf(b"") == []


def test_parse_pdf_emits_one_block_per_non_empty_page() -> None:
    pdf = _make_pdf(["Page one content.", "Page two content."])
    blocks = parse_pdf(pdf)
    assert len(blocks) == 2
    assert blocks[0].page == 1
    assert blocks[1].page == 2
    assert blocks[0].modality is ChunkModality.text


def test_parse_pdf_drops_blank_pages() -> None:
    pdf = _make_pdf(["First.", "", "  ", "Last."])
    blocks = parse_pdf(pdf)
    pages = [b.page for b in blocks]
    assert pages == [1, 4]


def test_parse_pdf_preserves_text_content() -> None:
    pdf = _make_pdf(["Gradient descent is an algorithm."])
    blocks = parse_pdf(pdf)
    assert "Gradient descent" in blocks[0].text


def test_parse_pdf_carries_dimensional_meta() -> None:
    pdf = _make_pdf(["just enough"])
    blocks = parse_pdf(pdf)
    meta = blocks[0].meta
    assert "width" in meta and meta["width"] > 0
    assert "height" in meta and meta["height"] > 0
    assert "rotation" in meta


def test_parse_pdf_assigns_sequential_char_offsets() -> None:
    pdf = _make_pdf(["First page text.", "Second page text."])
    blocks = parse_pdf(pdf)
    # Char offsets are sequential — second block starts where first ended.
    assert blocks[0].char_end == blocks[1].char_start


@pytest.mark.parametrize("payload", [b"not a pdf", b"\x00\x01\x02"])
def test_parse_pdf_raises_on_garbage(payload: bytes) -> None:
    with pytest.raises(Exception):
        parse_pdf(payload)
