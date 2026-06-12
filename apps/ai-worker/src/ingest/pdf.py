"""PDF parser using PyMuPDF.

One ``Block`` per page. The chunker dispatcher (``rag.chunker``) sub-divides
each Block via the text-aware strategy; page boundaries are never crossed —
chunks inherit ``page=N`` from the producing Block.

We use ``fitz.open(stream=…)`` so the parser is pure (no filesystem coupling)
and trivially testable.

When PyMuPDF returns zero extractable text we fall back to per-page OCR via
Tesseract — common on scanned PDFs, slide decks exported as bitmaps, and
documents where the text layer was stripped. The OCR fallback is opt-in
on the *content* (we only invoke it when the cheap path yielded nothing)
rather than opt-in on the user, so students don't have to know about it.
"""

from __future__ import annotations

import io
import logging
from typing import Any

import fitz  # PyMuPDF — name remains `fitz` for historical reasons

from ..agents.contracts import Block, ChunkModality

log = logging.getLogger(__name__)

# Rasterization DPI for the OCR fallback. 200 is the Tesseract sweet
# spot — 150 starts producing noticeably worse quality on small fonts;
# 300+ is significantly slower with little additional accuracy on
# printed text. Override via ``PDF_OCR_DPI`` for documents that need it.
_OCR_DPI = 200


def parse_pdf(pdf_bytes: bytes) -> list[Block]:
    """Return one Block per non-empty page, in page order.

    Two paths:

      1. PyMuPDF text extraction (fast, free) — works for any PDF with a
         real text layer. The 99% case.
      2. Per-page OCR fallback — kicks in only when path 1 yields zero
         blocks. Rasterizes each page and runs Tesseract. Slower (≈ 1s
         per page on a modern CPU at 200 DPI) but rescues scanned PDFs
         that would otherwise fail ingest entirely.

    Blank pages are dropped silently in both paths — they carry no
    signal and only inflate the chunk count.
    """
    if not pdf_bytes:
        return []

    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    try:
        blocks = _extract_text_layer(doc)
        if blocks:
            return blocks
        # Empty text layer → scanned / image-only PDF. Run OCR.
        log.info(
            "pdf.text_layer_empty pages=%d — falling back to per-page OCR",
            doc.page_count,
        )
        return _ocr_fallback(doc)
    finally:
        doc.close()


def _extract_text_layer(doc: Any) -> list[Block]:
    """The standard cheap path. Returns ``[]`` when the PDF has no
    embedded text — caller switches to OCR."""
    blocks: list[Block] = []
    char_cursor = 0
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
    return blocks


def _ocr_fallback(doc: Any) -> list[Block]:
    """Per-page OCR for scanned / image-only PDFs.

    Lazy-imports Pillow + pytesseract so PDFs with text layers don't pay
    the cost. Returns blocks with modality ``text`` (not ``image_ocr``)
    so the text-aware chunker sub-divides long OCR'd pages — a scanned
    textbook page might be 2000 words and shouldn't survive as one
    monolithic chunk.
    """
    try:
        import pytesseract
        from PIL import Image
    except ImportError as exc:
        log.error("pdf.ocr_unavailable err=%s", exc)
        return []

    blocks: list[Block] = []
    char_cursor = 0
    total_chars = 0
    for page_index in range(doc.page_count):
        page = doc.load_page(page_index)
        # ``get_pixmap`` with a matrix scales the page to the requested
        # DPI. We pass alpha=False since Tesseract doesn't use it and
        # opaque images are smaller in memory.
        pixmap = page.get_pixmap(dpi=_OCR_DPI, alpha=False)
        png_bytes = pixmap.tobytes("png")
        try:
            # ``Image.open`` returns ``ImageFile``; ``.convert`` returns
            # ``Image``. Annotate as the union-friendly ``Image.Image``
            # so the reassignment after ``.convert`` typechecks.
            img: Image.Image = Image.open(io.BytesIO(png_bytes))
            img.load()
            if img.mode not in ("RGB", "L"):
                img = img.convert("RGB")
            text = pytesseract.image_to_string(img)
        except pytesseract.TesseractNotFoundError:  # pragma: no cover
            log.error(
                "pdf.ocr_tesseract_missing — install with `brew install tesseract` "
                "or `apt-get install tesseract-ocr`",
            )
            return []
        except Exception as exc:
            log.warning(
                "pdf.ocr_page_failed page=%d err=%s",
                page_index + 1,
                exc,
            )
            continue
        stripped = (text or "").strip()
        if not stripped:
            continue
        page_number = page_index + 1
        blocks.append(
            Block(
                modality=ChunkModality.text,
                text=stripped,
                page=page_number,
                char_start=char_cursor,
                char_end=char_cursor + len(stripped),
                meta={**_page_meta(page), "source": "pdf_ocr", "ocr_dpi": _OCR_DPI},
            )
        )
        char_cursor += len(stripped)
        total_chars += len(stripped)
    log.info(
        "pdf.ocr_complete pages=%d blocks=%d chars=%d",
        doc.page_count,
        len(blocks),
        total_chars,
    )
    return blocks


def _page_meta(page: Any) -> dict[str, Any]:
    rect = page.rect
    return {
        "width": float(rect.width),
        "height": float(rect.height),
        "rotation": int(page.rotation),
    }
