"""End-to-end ingest pipeline.

    bytes → parse (PDF) → safety pass → chunk → persist
                                                 → IngestResult

The pipeline is intentionally pure-functional except for the persistence step,
which is delegated to an injected ``IngestStore``. Tests substitute the
in-memory store; production wires the Postgres store.
"""

from __future__ import annotations

import hashlib
import logging
import unicodedata
from collections.abc import Sequence
from dataclasses import dataclass
from uuid import uuid4

from ..agents.contracts import Block, SafetyFlag, SanitizedBlock
from ..rag.chunker import ChunkerDispatcher
from .docx import parse_docx
from .notebook import parse_ipynb_json, parse_notebook
from .pdf import parse_pdf
from .plaintext import parse_plaintext
from .pptx import parse_pptx
from .safety_pass import safety_pass
from .store import (
    DocumentRow,
    DocumentVersionRow,
    IngestStore,
    WrittenChunk,
)

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class IngestRequest:
    tenant_id: str
    course_id: str | None
    folder_id: str | None
    upload_batch_id: str
    mime: str
    original_filename: str
    s3_key: str
    bytes: bytes


@dataclass(frozen=True)
class IngestResult:
    document_id: str
    document_version_id: str
    chunk_count: int
    page_count: int
    bytes_sha256: str
    content_sha256: str
    safety_flags: list[SafetyFlag]
    written_chunks: list[WrittenChunk]


async def ingest_document(req: IngestRequest, store: IngestStore) -> IngestResult:
    """Run the full pipeline and persist via ``store``. Returns an
    ``IngestResult`` summarising what was written. Idempotency at the
    application layer is handled by the orchestrator using the bytes hash."""
    blocks = _parse_by_mime(req.mime, req.original_filename, req.bytes)
    if not blocks:
        raise EmptyParseError(req.mime, req.original_filename)
    safety = safety_pass(blocks)
    chunks = ChunkerDispatcher().chunk_blocks(list(safety.sanitized))

    bytes_sha256 = hashlib.sha256(req.bytes).hexdigest()
    content_sha256 = _normalised_content_hash(safety.sanitized)

    document_row = DocumentRow(
        id=str(uuid4()),
        tenant_id=req.tenant_id,
        course_id=req.course_id,
        folder_id=req.folder_id,
        upload_batch_id=req.upload_batch_id,
        mime=req.mime,
        original_filename=req.original_filename,
        s3_key=req.s3_key,
        page_count=_count_pages(blocks),
        language=None,
    )
    document_id = await store.write_document(document_row)

    version_row = DocumentVersionRow(
        id=str(uuid4()),
        document_id=document_id,
        version_number=1,
        content_sha256=content_sha256,
        bytes_sha256=bytes_sha256,
    )
    version_id = await store.write_document_version(version_row)

    written = await store.write_chunks(document_version_id=version_id, chunks=chunks)

    log.info(
        "ingest.complete tenant=%s document_id=%s pages=%s chunks=%s flags=%s",
        req.tenant_id,
        document_id,
        document_row.page_count,
        len(chunks),
        [f.value for f in safety.flags],
    )

    return IngestResult(
        document_id=document_id,
        document_version_id=version_id,
        chunk_count=len(chunks),
        page_count=document_row.page_count or 0,
        bytes_sha256=bytes_sha256,
        content_sha256=content_sha256,
        safety_flags=safety.flags,
        written_chunks=written,
    )


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────


def _count_pages(blocks: Sequence[Block]) -> int | None:
    """Pages for PDFs; slides for PPTX; cell count for notebooks.

    The ``Document.pageCount`` column is a single integer regardless of the
    source modality, so we report whichever locator the parser populated.
    """
    pages = {b.page for b in blocks if b.page is not None}
    if pages:
        return max(pages)
    slides = {b.slide for b in blocks if b.slide is not None}
    if slides:
        return max(slides)
    cells = {b.cell for b in blocks if b.cell is not None}
    if cells:
        return max(cells)
    return None


# MIME-aware dispatch. Adding a parser is a two-line change: register the
# constant here and import the function above.
_PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation"
_DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
_IPYNB_MIMES = {"application/x-ipynb+json", "application/x-jupyter-notebook"}
_TEXT_MIMES = {"text/plain", "text/markdown", "text/x-markdown", "application/json"}


def _parse_by_mime(mime: str, filename: str, content: bytes) -> list[Block]:
    if mime == "application/pdf":
        return parse_pdf(content)
    if mime == _PPTX_MIME or filename.lower().endswith(".pptx"):
        return parse_pptx(content)
    if mime == _DOCX_MIME or filename.lower().endswith(".docx"):
        return parse_docx(content)
    if mime in _IPYNB_MIMES or filename.lower().endswith(".ipynb"):
        # nbformat is strict; fall back to raw JSON parsing if it rejects.
        blocks = parse_notebook(content)
        return blocks if blocks else parse_ipynb_json(content)
    if mime in _TEXT_MIMES or filename.lower().endswith((".txt", ".md", ".markdown", ".json")):
        return parse_plaintext(content)
    raise UnsupportedMimeError(mime)


def _normalised_content_hash(blocks: Sequence[SanitizedBlock]) -> str:
    """sha256 over the post-safety, NFC-normalised, whitespace-stable text.

    Same shape as ``Course.contentSha256`` from §3 — two uploads of the same
    file with different filenames or trivial whitespace differences collapse
    to the same hash. This is what makes the course-shared artifact cache
    work."""
    h = hashlib.sha256()
    for block in blocks:
        normalised = unicodedata.normalize("NFC", " ".join(block.text.split()))
        h.update(block.modality.value.encode("utf-8"))
        h.update(b"\x00")
        h.update(normalised.encode("utf-8"))
        h.update(b"\x01")
    return h.hexdigest()


class UnsupportedMimeError(ValueError):
    def __init__(self, mime: str) -> None:
        super().__init__(f"ingest pipeline does not yet handle MIME {mime!r}")
        self.mime = mime


class EmptyParseError(ValueError):
    """Parser ran but found no extractable content. Distinct from
    ``UnsupportedMimeError`` so the gateway can surface a clearer error
    (corrupt upload vs. wrong format)."""

    def __init__(self, mime: str, filename: str) -> None:
        super().__init__(f"no content extracted from {filename!r} ({mime})")
        self.mime = mime
        self.filename = filename
