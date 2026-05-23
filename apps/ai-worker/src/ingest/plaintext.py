"""Plain text / markdown / json parser.

A single ``text`` Block carrying the decoded UTF-8 content. The
``TextChunker`` will heading-split (for markdown) or sentence-window
(everything else).
"""

from __future__ import annotations

import logging

from ..agents.contracts import Block, ChunkModality

log = logging.getLogger(__name__)


def parse_plaintext(content_bytes: bytes) -> list[Block]:
    if not content_bytes:
        return []
    try:
        text = content_bytes.decode("utf-8", errors="replace").strip()
    except Exception:  # noqa: BLE001
        return []
    if not text:
        return []
    return [
        Block(
            modality=ChunkModality.text,
            text=text,
            char_start=0,
            char_end=len(text),
            meta={},
        )
    ]
