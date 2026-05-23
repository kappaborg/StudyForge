"""PDF parser using PyMuPDF.

One ``Block`` per page. The chunker dispatcher (``rag.chunker``) sub-divides
each Block via the text-aware strategy; page boundaries are never crossed —
chunks inherit ``page=N`` from the producing Block.

We use ``fitz.open(stream=…)`` so the parser is pure (no filesystem coupling)
and trivially testable.
"""

from __future__ import annotations

import logging
from typing import Any

import fitz  # PyMuPDF — name remains `fitz` for historical reasons

from ..agents.contracts import Block, ChunkModality

log = logging.getLogger(__name__)


def parse_pdf(pdf_bytes: bytes) -> list[Block]:
    """Return one Block per non-empty page, in page order.

    Blank pages are dropped silently — they carry no signal and only inflate
    the chunk count. The producing page number is preserved on each Block so
    citations can point back to the right spread.
    """
    if not pdf_bytes:
        return []

    blocks: list[Block] = []
    char_cursor = 0
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    try:
        for page_index in range(doc.page_count):
            page = doc.load_page(page_index)
            text = page.get_text("text") or ""
            stripped = text.strip()
            if not stripped:
                continue
            page_number = page_index + 1
            block = Block(
                modality=ChunkModality.text,
                text=stripped,
                page=page_number,
                char_start=char_cursor,
                char_end=char_cursor + len(stripped),
                meta=_page_meta(page),
            )
            blocks.append(block)
            char_cursor += len(stripped)
    finally:
        doc.close()
    return blocks


def _page_meta(page: Any) -> dict[str, Any]:
    rect = page.rect
    return {
        "width": float(rect.width),
        "height": float(rect.height),
        "rotation": int(page.rotation),
    }
