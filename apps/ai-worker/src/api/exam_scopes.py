"""POST /v1/exam-scopes/parse — turn a free-text exam scope into a
structured ``{title, scopes[]}`` object.

This is a deliberately conservative regex parser, not an LLM call. The
shapes we care about cover ~90% of what professors actually post:

    "Theory: Chapter 4 and 6 (Mapping and Microbial Genetics).
     Problems: Chapter 4 (Mapping/Linkage Analysis)"

    "Midterm covers ch.3, ch.5"

    "Topics 1-3 inclusive"

If we hit something we can't parse we return a single ``theory``-mode
scope with whatever chapters we did find — the student confirms via the
UI before saving, and can edit anything the parser missed. A future LLM
fallback can land here without changing the contract.
"""

from __future__ import annotations

import logging
import re
from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict, Field

log = logging.getLogger(__name__)

# ── Patterns ────────────────────────────────────────────────────────────────

# Section heads ("Theory:", "Problems:", "Exercises:") split a message into
# typed sub-scopes. We match the label + everything up to the next label or
# end-of-string.
_LABEL_THEORY = ("theory", "lecture", "concepts", "reading")
_LABEL_PROBLEMS = ("problems", "problem", "exercises", "practice", "homework", "questions")

_LABEL_RE = re.compile(
    r"\b(" + "|".join([*_LABEL_THEORY, *_LABEL_PROBLEMS]) + r")\s*:\s*",
    flags=re.IGNORECASE,
)

# "Chapter 4 and 6", "Ch.3", "ch 5", "Lecture 7", "Topic 12", "Module 2",
# "Week 4". Captures the trailing chapter list (digits + connectors) so we
# can extract every number in one go.
_CHAPTERS_RE = re.compile(
    r"\b(?:chapter|chapters?|ch\.?|lecture|lec\.?|topic|topics?|unit|module|week)s?\s*"
    r"(\d+(?:\s*(?:,|and|&|-|–|to)\s*\d+)*)",
    flags=re.IGNORECASE,
)

# Standalone number runs after a label like "covers 4, 5 and 6".
_BARE_NUMBERS_RE = re.compile(r"(?:^|\s)(\d+(?:\s*(?:,|and|&)\s*\d+){0,8})(?=\s|[.)]|$)")

# Topics in parens or after a dash: "(Mapping and Microbial Genetics)",
# "— Mapping/Linkage Analysis"
_PAREN_TOPIC_RE = re.compile(r"\(([^)]{2,120})\)")
_DASH_TOPIC_RE = re.compile(r"[—–-]\s*([A-Za-z][A-Za-z0-9 ,/&'\-]{2,80})")

# Split topic clusters: "Mapping and Microbial Genetics" → ["Mapping",
# "Microbial Genetics"]; "Mapping/Linkage Analysis" → ["Mapping", "Linkage
# Analysis"]
_TOPIC_SEP_RE = re.compile(r"\s*(?:,|/|;| and | & )\s*", flags=re.IGNORECASE)


def _expand_chapter_run(raw: str) -> list[int]:
    """Turn ``"4 and 6"`` → ``[4, 6]``; ``"3-5"`` → ``[3, 4, 5]``."""
    out: list[int] = []
    # Split on "-"/"–"/"to" first to handle ranges, then split by , / and / &.
    parts = re.split(r"\s*(?:-|–|to)\s*", raw)
    if len(parts) == 2 and parts[0].strip().isdigit() and parts[1].strip().isdigit():
        a, b = int(parts[0]), int(parts[1])
        if 0 < a <= b < 1000:
            return list(range(a, b + 1))
    for token in re.split(r"\s*(?:,|and|&)\s*", raw, flags=re.IGNORECASE):
        token = token.strip()
        if token.isdigit():
            n = int(token)
            if 0 < n < 1000:
                out.append(n)
    # Dedupe but keep order.
    seen: set[int] = set()
    dedup: list[int] = []
    for n in out:
        if n not in seen:
            seen.add(n)
            dedup.append(n)
    return dedup


def _extract_topics(text: str) -> list[str]:
    topics: list[str] = []
    seen: set[str] = set()
    for source_re in (_PAREN_TOPIC_RE, _DASH_TOPIC_RE):
        for m in source_re.finditer(text):
            raw = m.group(1).strip()
            for part in _TOPIC_SEP_RE.split(raw):
                cleaned = part.strip().strip(".,;")
                if 2 <= len(cleaned) <= 80:
                    lower = cleaned.lower()
                    if lower not in seen:
                        seen.add(lower)
                        topics.append(cleaned)
    return topics


def _label_to_mode(label: str) -> Literal["theory", "problems"]:
    return "problems" if label.lower() in _LABEL_PROBLEMS else "theory"


def _parse_segment(text: str) -> tuple[list[int], list[str]]:
    """Returns ``(chapters, topics)`` for a labelled segment."""
    chapters: list[int] = []
    seen: set[int] = set()
    for m in _CHAPTERS_RE.finditer(text):
        for n in _expand_chapter_run(m.group(1)):
            if n not in seen:
                seen.add(n)
                chapters.append(n)
    # If no chapters via explicit label, try bare-numbers fallback.
    if not chapters:
        for m in _BARE_NUMBERS_RE.finditer(text):
            for n in _expand_chapter_run(m.group(1)):
                if n not in seen:
                    seen.add(n)
                    chapters.append(n)
    topics = _extract_topics(text)
    return chapters, topics


def _derive_title(text: str, scopes: list[dict[str, object]]) -> str:
    # Prefer the first line if it looks like a header ("Midterm prep").
    first_line = text.strip().splitlines()[0].strip(" .:;")
    if 4 <= len(first_line) <= 100 and not first_line.lower().startswith(
        (*_LABEL_THEORY, *_LABEL_PROBLEMS)
    ):
        return first_line[:100]
    # Otherwise stitch one from the chapter union.
    chapters: set[int] = set()
    topics: list[str] = []
    for s in scopes:
        for c in s.get("chapters", []) or []:  # type: ignore[union-attr]
            if isinstance(c, int):
                chapters.add(c)
        for t in s.get("topics", []) or []:  # type: ignore[union-attr]
            if isinstance(t, str) and t not in topics:
                topics.append(t)
    if chapters:
        chap_str = "Ch. " + ", ".join(str(n) for n in sorted(chapters))
        if topics:
            return f"{topics[0]} — {chap_str}"
        return f"Exam scope ({chap_str})"
    return "Exam scope"


def parse_exam_scope(text: str) -> dict[str, object]:
    """Top-level entry. Splits on Theory:/Problems: labels and parses each."""
    labels = list(_LABEL_RE.finditer(text))
    scopes: list[dict[str, object]] = []
    if labels:
        for i, m in enumerate(labels):
            label = m.group(1)
            seg_start = m.end()
            seg_end = labels[i + 1].start() if i + 1 < len(labels) else len(text)
            segment = text[seg_start:seg_end]
            chapters, topics = _parse_segment(segment)
            if not chapters and not topics:
                continue
            scopes.append(
                {
                    "mode": _label_to_mode(label),
                    "chapters": chapters,
                    "topics": topics,
                }
            )
    else:
        # No explicit labels — treat the whole thing as one theory scope.
        chapters, topics = _parse_segment(text)
        if chapters or topics:
            scopes.append(
                {
                    "mode": "theory",
                    "chapters": chapters,
                    "topics": topics,
                }
            )
    if not scopes:
        scopes.append({"mode": "theory", "chapters": [], "topics": []})
    return {"title": _derive_title(text, scopes), "scopes": scopes}


# ── HTTP surface ────────────────────────────────────────────────────────────


class ScopeEntry(BaseModel):
    model_config = ConfigDict(extra="forbid")
    mode: Literal["theory", "problems"]
    chapters: list[int]
    topics: list[str]


class ParseRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: str = Field(min_length=1, max_length=8000)


class ParseResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str
    scopes: list[ScopeEntry]


def build_router() -> APIRouter:
    router = APIRouter(prefix="/v1/exam-scopes", tags=["exam-scopes"])

    @router.post("/parse", response_model=ParseResponse)
    async def parse_scope(req: ParseRequest) -> ParseResponse:
        parsed = parse_exam_scope(req.text)
        return ParseResponse(**parsed)  # type: ignore[arg-type]

    return router


__all__ = ["build_router", "parse_exam_scope"]
