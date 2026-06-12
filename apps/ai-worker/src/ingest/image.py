"""Image → text via Tesseract OCR.

Students upload screenshots — lecture slides, textbook pages, whiteboard
photos, math problem images, scans of handwritten notes. We OCR the
bytes once at ingest, persist the recovered text as a single ``Block``
with modality ``image_ocr``, and everything downstream (chunker, RAG,
flashcards, scopes) just sees text. Citations preserve the original
S3 key so a future "show me the source image" UI has something to load.

Why Tesseract:
  • Already installed via Homebrew on macOS dev machines and apt on
    Linux servers; no new model weights to download.
  • Pure CPU, no GPU dependency.
  • Quality is solid for printed text (slides, textbook scans).
    Handwriting and equations are best-effort — students should expect
    typed-text pages to work well and dense math to be hit-or-miss.

When OCR returns nothing usable (a logo, an abstract diagram, a
hand-drawn chart), we raise ``EmptyOcrError`` so the pipeline surfaces a
clear "no text found in this image" rather than persisting an empty
document.
"""

from __future__ import annotations

import io
import logging
from typing import Any

from ..agents.contracts import Block, ChunkModality

log = logging.getLogger(__name__)

_IMAGE_MIMES = {
    "image/png",
    "image/jpeg",
    "image/jpg",
    "image/webp",
    "image/bmp",
    "image/tiff",
    "image/gif",
}
_IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tiff", ".tif", ".gif")


def is_image(mime: str, filename: str) -> bool:
    if mime in _IMAGE_MIMES:
        return True
    lower = filename.lower()
    return any(lower.endswith(ext) for ext in _IMAGE_EXTS)


def parse_image(image_bytes: bytes, *, filename: str = "image") -> list[Block]:
    """Run Tesseract on a single image and return its text as one Block.

    Follows the ingest-module convention: empty / unreadable input
    returns ``[]`` and the pipeline turns that into a clean
    ``EmptyParseError`` with the original filename, surfaced to the API
    gateway as a 4xx instead of a 5xx.

    Why one Block, not one-per-line: the chunker's
    ``OneChunkPerBlockStrategy`` keeps each Block as one Chunk, which
    is what we want — a screenshot of a slide is one logical unit and
    should retrieve as one citation rather than fracturing into per-line
    fragments.
    """
    if not image_bytes:
        return []

    # Lazy-import Pillow + pytesseract here so the worker boot doesn't
    # pull them in when no images are ever uploaded.
    import pytesseract
    from PIL import Image, UnidentifiedImageError

    try:
        # ``Image.open`` returns ``ImageFile``; ``.convert`` returns
        # ``Image``. Annotate as the union-friendly ``Image.Image`` so
        # the reassignment after ``.convert`` typechecks.
        img: Image.Image = Image.open(io.BytesIO(image_bytes))
        # ``Image.open`` is lazy — force the actual decode so format
        # errors surface here instead of inside pytesseract.
        img.load()
    except UnidentifiedImageError as exc:
        log.warning("image.decode_failed filename=%s err=%s", filename, exc)
        return []

    # Tesseract is more reliable on RGB (or grayscale); some PNGs land
    # as palette or RGBA which trips the C lib on certain configs.
    if img.mode not in ("RGB", "L"):
        img = img.convert("RGB")

    try:
        text = pytesseract.image_to_string(img)
    except pytesseract.TesseractNotFoundError:  # pragma: no cover
        # Tesseract missing on the worker host. Surface as an empty
        # parse so the operator gets a 4xx and the worker logs guide
        # them to install. ``brew install tesseract`` on macOS,
        # ``apt-get install tesseract-ocr`` on Linux.
        log.error(
            "image.tesseract_missing — install the tesseract binary "
            "(brew install tesseract / apt-get install tesseract-ocr)",
        )
        return []
    except Exception as exc:
        log.warning("image.ocr_failed filename=%s err=%s", filename, exc)
        return []

    stripped = (text or "").strip()
    log.info(
        "image.ocr filename=%s mode=%s size=%dx%d chars=%d",
        filename,
        img.mode,
        img.width,
        img.height,
        len(stripped),
    )

    # Empty OCR or essentially-empty (Tesseract sometimes guesses a few
    # noise chars on a diagram-only image). Treat as "no text found"
    # and let the pipeline raise the standard EmptyParseError.
    if len(stripped) < 8 or _is_mostly_noise(stripped):
        return []

    return [
        Block(
            modality=ChunkModality.image_ocr,
            text=stripped,
            char_start=0,
            char_end=len(stripped),
            meta=_image_meta(img, filename),
        )
    ]


def _is_mostly_noise(text: str) -> bool:
    """Heuristic: Tesseract sometimes returns a few garbled characters
    on diagram-only images. Treat "< 30% of chars are letters" as
    non-text. Cheap rule, catches the common failure mode where the
    OCR engine reports nonsense rather than refusing."""
    if not text:
        return True
    letters = sum(1 for c in text if c.isalpha())
    return letters / len(text) < 0.3


def _image_meta(img: Any, filename: str) -> dict[str, Any]:
    return {
        "source": "image_ocr",
        "filename": filename,
        "width": img.width,
        "height": img.height,
        "mode": img.mode,
        "format": getattr(img, "format", None),
    }


__all__ = ["is_image", "parse_image"]
