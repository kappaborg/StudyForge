"""DOCX parser using python-docx.

Emits a single ``text`` Block whose content is the document body with
headings prefixed in Markdown form (``# Heading``). The downstream
``TextChunker`` already understands the ``#`` markers and uses them to
split into heading-aware chunks, so we don't need a per-paragraph Block.
"""

from __future__ import annotations

import io
import logging

from docx import Document

from ..agents.contracts import Block, ChunkModality

log = logging.getLogger(__name__)


def parse_docx(docx_bytes: bytes) -> list[Block]:
    if not docx_bytes:
        return []

    doc = Document(io.BytesIO(docx_bytes))
    lines: list[str] = []
    for paragraph in doc.paragraphs:
        text = (paragraph.text or "").strip()
        if not text:
            continue
        style = (paragraph.style.name if paragraph.style else "") or ""
        # python-docx exposes Word heading styles as "Heading 1" .. "Heading 9".
        if style.lower().startswith("heading"):
            try:
                level = int(style.split()[-1])
            except (ValueError, IndexError):
                level = 1
            level = max(1, min(level, 6))
            lines.append(f"{'#' * level} {text}")
        else:
            lines.append(text)

    body = "\n\n".join(lines).strip()
    if not body:
        return []
    return [
        Block(
            modality=ChunkModality.text,
            text=body,
            char_start=0,
            char_end=len(body),
            meta={},
        )
    ]
