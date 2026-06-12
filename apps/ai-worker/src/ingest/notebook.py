"""Jupyter notebook (.ipynb) parser using nbformat.

One ``Block`` per cell. Markdown cells become ``text`` modality, code cells
become ``code`` modality; the chunker dispatcher routes them to the right
strategy. Cell outputs are dropped — they're noisy, often large, and rarely
quoted by students.
"""

from __future__ import annotations

import io
import json
import logging

import nbformat

from ..agents.contracts import Block, ChunkModality

log = logging.getLogger(__name__)


def parse_notebook(ipynb_bytes: bytes) -> list[Block]:
    if not ipynb_bytes:
        return []

    try:
        nb = nbformat.read(io.BytesIO(ipynb_bytes), as_version=4)  # type: ignore[no-untyped-call]
    except Exception as exc:
        log.warning("notebook parse failed: %s", exc)
        return []

    blocks: list[Block] = []
    char_cursor = 0
    for cell_index, cell in enumerate(nb.cells, start=1):
        source = cell.get("source", "")
        if isinstance(source, list):
            source = "".join(source)
        text = (source or "").strip()
        if not text:
            continue
        cell_type = cell.get("cell_type", "")
        if cell_type == "code":
            modality = ChunkModality.code
        elif cell_type == "markdown":
            modality = ChunkModality.text
        else:
            # Raw cells, etc. Treat as text so they don't get lost.
            modality = ChunkModality.text
        blocks.append(
            Block(
                modality=modality,
                text=text,
                cell=cell_index,
                char_start=char_cursor,
                char_end=char_cursor + len(text),
                meta={"cell_type": cell_type},
            )
        )
        char_cursor += len(text)
    return blocks


def parse_ipynb_json(ipynb_bytes: bytes) -> list[Block]:
    """Fallback path: parse raw JSON if nbformat rejects the file."""
    try:
        nb = json.loads(ipynb_bytes)
    except json.JSONDecodeError:
        return []
    blocks: list[Block] = []
    char_cursor = 0
    for cell_index, cell in enumerate(nb.get("cells", []), start=1):
        source = cell.get("source", "")
        if isinstance(source, list):
            source = "".join(source)
        text = (source or "").strip()
        if not text:
            continue
        cell_type = cell.get("cell_type", "")
        modality = ChunkModality.code if cell_type == "code" else ChunkModality.text
        blocks.append(
            Block(
                modality=modality,
                text=text,
                cell=cell_index,
                char_start=char_cursor,
                char_end=char_cursor + len(text),
                meta={"cell_type": cell_type},
            )
        )
        char_cursor += len(text)
    return blocks
