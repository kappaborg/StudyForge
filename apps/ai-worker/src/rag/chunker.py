"""Per-modality chunking.

Structural boundaries always win over token counts. The token limit is the
fallback inside a chosen structural unit, never the primary signal — chunks
that cross slide / cell / heading boundaries break citation reliability.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Protocol

from ..agents.contracts import Block, ChunkModality

# Approximate tokens-per-character. We deliberately under-count to keep chunks
# inside provider limits; the real tokenizer runs in the embedder.
APPROX_CHARS_PER_TOKEN = 4
TEXT_SOFT_CAP_TOKENS = 512
TEXT_HARD_CAP_TOKENS = 768
TEXT_OVERLAP_TOKENS = 96

HEADING_RE = re.compile(r"^(#{1,6})\s+(.*\S)\s*$", flags=re.MULTILINE)

# ── Chapter/section/content-type detection ──────────────────────────────────
#
# These regexes feed ``_classify_for_scope`` below. We deliberately keep them
# conservative — the goal is to populate ``chunk.meta.chapter`` cleanly for
# the 70% of textbooks / lecture decks that follow conventional numbering.
# Anything weirder (Roman numerals, A.1, Lesson Three) falls through and is
# handled by a future LLM pass or by the manual chapter-tagging UI.
_CHAPTER_RE = re.compile(
    r"\b(?:chapter|ch\.?|lecture|lec\.?|topic|unit|module|week)\s+(\d{1,3})\b",
    flags=re.IGNORECASE,
)
_SECTION_RE = re.compile(r"\b(\d{1,3}\.\d{1,3}(?:\.\d{1,3})?)\b")
_PROBLEMS_RE = re.compile(
    r"\b(?:problems?|exercises?|questions?|worked\s+examples?|practice|homework)\b",
    flags=re.IGNORECASE,
)
_EXAMPLE_RE = re.compile(r"\b(?:example|worked\s+example|case\s+study)\b", flags=re.IGNORECASE)


def _classify_for_scope(
    heading_path: tuple[str, ...], content: str
) -> dict[str, Any]:
    """Pull chapter / section / contentType signals out of a chunk.

    We look at ``heading_path`` first because heading text is the most
    reliable signal — body text often references chapter numbers it isn't
    actually part of (a Ch.4 chunk that says "see chapter 7" shouldn't get
    tagged as Ch.7). For chunks without headings we sample the first 200
    chars of content as a fallback.
    """
    out: dict[str, Any] = {}
    search_text = " ".join(heading_path) if heading_path else content[:200]

    m = _CHAPTER_RE.search(search_text)
    if m:
        try:
            out["chapter"] = int(m.group(1))
        except ValueError:
            pass

    s = _SECTION_RE.search(search_text)
    if s:
        out["section"] = s.group(1)

    # Content type: heading text wins, then content. "Problems" or "Exercises"
    # in any ancestor heading marks the whole subtree as practice material.
    classifier_text = " ".join(heading_path) + " " + content[:300]
    if _PROBLEMS_RE.search(classifier_text):
        out["contentType"] = "problems"
    elif _EXAMPLE_RE.search(classifier_text):
        out["contentType"] = "example"
    else:
        out["contentType"] = "theory"

    return out
SENTENCE_BOUNDARY_RE = re.compile(r"(?<=[.!?])\s+(?=[A-Z(])")


@dataclass(frozen=True)
class Chunk:
    """A chunker output. Mirrors the schema of ``Chunk`` rows in Postgres."""

    ordinal: int
    modality: ChunkModality
    content: str
    page: int | None = None
    slide: int | None = None
    cell: int | None = None
    char_start: int = 0
    char_end: int = 0
    heading_path: tuple[str, ...] = ()
    meta: dict[str, Any] = field(default_factory=dict)


class ChunkStrategy(Protocol):
    """Each modality plugs in via this protocol."""

    def chunk(self, block: Block, *, starting_ordinal: int) -> list[Chunk]: ...


# ─────────────────────────────────────────────────────────────────────────────
# Text strategy (heading-aware, sentence-window, overlap-tuned)
# ─────────────────────────────────────────────────────────────────────────────


class TextChunker:
    def __init__(
        self,
        *,
        soft_cap_tokens: int = TEXT_SOFT_CAP_TOKENS,
        hard_cap_tokens: int = TEXT_HARD_CAP_TOKENS,
        overlap_tokens: int = TEXT_OVERLAP_TOKENS,
    ) -> None:
        if soft_cap_tokens <= overlap_tokens:
            raise ValueError("soft_cap_tokens must exceed overlap_tokens")
        if hard_cap_tokens < soft_cap_tokens:
            raise ValueError("hard_cap_tokens must be >= soft_cap_tokens")
        self._soft = soft_cap_tokens
        self._hard = hard_cap_tokens
        self._overlap = overlap_tokens

    def chunk(self, block: Block, *, starting_ordinal: int) -> list[Chunk]:
        sections = self._split_by_heading(block.text)
        results: list[Chunk] = []
        ordinal = starting_ordinal
        for heading_path, section_text, section_offset in sections:
            for piece in self._split_section(section_text):
                start = section_offset + piece.start
                end = section_offset + piece.end
                # New meta dict per chunk so the per-chunk scope tags don't
                # alias back into ``block.meta`` (which is shared across all
                # chunks from this block).
                meta = {**block.meta, **_classify_for_scope(tuple(heading_path), piece.text)}
                results.append(
                    Chunk(
                        ordinal=ordinal,
                        modality=block.modality,
                        content=piece.text,
                        page=block.page,
                        slide=block.slide,
                        cell=block.cell,
                        char_start=block.char_start + start,
                        char_end=block.char_start + end,
                        heading_path=tuple(heading_path),
                        meta=meta,
                    )
                )
                ordinal += 1
        return results

    # ── splitting helpers ────────────────────────────────────────────────────

    def _split_by_heading(self, text: str) -> list[tuple[list[str], str, int]]:
        """Returns list of ``(heading_path, section_text, char_offset)`` tuples.

        Empty sections are dropped. The heading_path is the running stack of
        headings as we walk top-down — h1 stays in scope until the next h1.
        """
        sections: list[tuple[list[str], str, int]] = []
        matches = list(HEADING_RE.finditer(text))
        if not matches:
            stripped_text = text.strip()
            if stripped_text:
                offset = text.find(stripped_text)
                sections.append(([], stripped_text, offset))
            return sections

        stack: list[tuple[int, str]] = []  # (level, heading)
        cursor = 0
        for match in matches:
            heading_start = match.start()
            section_text = text[cursor:heading_start].strip()
            if section_text and stack:
                offset = text.find(section_text, cursor)
                sections.append(([h for _, h in stack], section_text, offset))
            level = len(match.group(1))
            heading = match.group(2).strip()
            while stack and stack[-1][0] >= level:
                stack.pop()
            stack.append((level, heading))
            cursor = match.end()
        tail = text[cursor:].strip()
        if tail and stack:
            offset = text.find(tail, cursor)
            sections.append(([h for _, h in stack], tail, offset))
        return sections

    def _split_section(self, text: str) -> list[TextPiece]:
        sentences = self._sentences(text)
        if not sentences:
            return []

        pieces: list[TextPiece] = []
        buffer: list[TextPiece] = []
        buffer_tokens = 0

        def flush() -> None:
            nonlocal buffer, buffer_tokens
            if not buffer:
                return
            content = " ".join(p.text for p in buffer).strip()
            start = buffer[0].start
            end = buffer[-1].end
            pieces.append(TextPiece(text=content, start=start, end=end))
            # carry overlap forward into the next buffer
            keep: list[TextPiece] = []
            keep_tokens = 0
            for piece in reversed(buffer):
                t = self._approx_tokens(piece.text)
                if keep_tokens + t > self._overlap:
                    break
                keep.insert(0, piece)
                keep_tokens += t
            buffer = list(keep)
            buffer_tokens = keep_tokens

        for sentence in sentences:
            t = self._approx_tokens(sentence.text)
            if buffer_tokens + t > self._soft and buffer:
                flush()
            buffer.append(sentence)
            buffer_tokens += t
            if buffer_tokens >= self._hard:
                flush()

        if buffer:
            content = " ".join(p.text for p in buffer).strip()
            pieces.append(
                TextPiece(text=content, start=buffer[0].start, end=buffer[-1].end)
            )
        return pieces

    def _sentences(self, text: str) -> list[TextPiece]:
        pieces: list[TextPiece] = []
        cursor = 0
        for match in SENTENCE_BOUNDARY_RE.finditer(text):
            sentence = text[cursor : match.start()].strip()
            if sentence:
                start = text.find(sentence, cursor)
                pieces.append(
                    TextPiece(text=sentence, start=start, end=start + len(sentence))
                )
            cursor = match.end()
        tail = text[cursor:].strip()
        if tail:
            start = text.find(tail, cursor)
            pieces.append(TextPiece(text=tail, start=start, end=start + len(tail)))
        return pieces

    @staticmethod
    def _approx_tokens(text: str) -> int:
        if not text:
            return 0
        return max(1, len(text) // APPROX_CHARS_PER_TOKEN)


@dataclass(frozen=True)
class TextPiece:
    text: str
    start: int
    end: int


# ─────────────────────────────────────────────────────────────────────────────
# Per-modality strategies (one-chunk-per-unit for structured modalities)
# ─────────────────────────────────────────────────────────────────────────────


class OneChunkPerBlockStrategy:
    """For slides, notebook cells, tables, formulas, OCR images.

    Each block becomes exactly one chunk; the modality boundary is preserved
    so citations point at the exact slide/cell/page.
    """

    def chunk(self, block: Block, *, starting_ordinal: int) -> list[Chunk]:
        if not block.text.strip():
            return []
        body = block.text.strip()
        meta = {**block.meta, **_classify_for_scope((), body)}
        return [
            Chunk(
                ordinal=starting_ordinal,
                modality=block.modality,
                content=body,
                page=block.page,
                slide=block.slide,
                cell=block.cell,
                char_start=block.char_start,
                char_end=block.char_end or block.char_start + len(block.text),
                heading_path=(),
                meta=meta,
            )
        ]


# ─────────────────────────────────────────────────────────────────────────────
# Dispatcher
# ─────────────────────────────────────────────────────────────────────────────


class ChunkerDispatcher:
    """Selects a strategy per ``block.modality``. New modalities register here."""

    def __init__(self) -> None:
        text = TextChunker()
        single = OneChunkPerBlockStrategy()
        self._strategies: dict[ChunkModality, ChunkStrategy] = {
            ChunkModality.text: text,
            ChunkModality.slide: single,
            ChunkModality.notebook_cell: single,
            ChunkModality.table: single,
            ChunkModality.formula: single,
            ChunkModality.image_ocr: single,
            # Code blocks are tree-sitter chunked in Phase 1; fall back to
            # one-chunk-per-block until that lands.
            ChunkModality.code: single,
        }

    def chunk_blocks(self, blocks: list[Block]) -> list[Chunk]:
        out: list[Chunk] = []
        ordinal = 0
        for block in blocks:
            strategy = self._strategies[block.modality]
            produced = strategy.chunk(block, starting_ordinal=ordinal)
            out.extend(produced)
            ordinal += len(produced)
        return out
