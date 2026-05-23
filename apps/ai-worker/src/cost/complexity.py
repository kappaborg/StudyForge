"""Sub-millisecond, deterministic complexity classifier.

Buckets every query into one of five classes so the router can pick the
cheapest provider that satisfies the quality bar for that class. Implemented
as a feature-based scorer rather than an LLM call — adding an LLM call here
would defeat the cost story.

Determinism is mandatory: identical input must always produce identical output
across runs, so the eval harness and the Grafana dashboards stay reproducible.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from enum import StrEnum


class ComplexityClass(StrEnum):
    simple = "simple"
    medium = "medium"
    code = "code"
    multi_doc = "multi_doc"
    complex = "complex"


@dataclass(frozen=True)
class ComplexityFinding:
    classification: ComplexityClass
    score: float
    reasons: tuple[str, ...]


_CODE_FENCE = re.compile(r"```|<code|/\*|=>|def\s+\w+\(|class\s+\w+\s*[:({]", re.IGNORECASE)
_CODE_KEYWORDS = re.compile(
    r"\b(function|class|import|return|async|await|def|let|const|var|public|private|interface|struct|enum)\b",
    re.IGNORECASE,
)
_COMPARISON_VOCAB = re.compile(
    r"\b(compare|contrast|difference|differences|differ|versus|vs\.?|both|each)\b",
    re.IGNORECASE,
)
_MULTI_DOC_VOCAB = re.compile(
    # Multi-doc cues require an explicit corpus-spanning phrase. "Between X and
    # Y" alone is not multi-doc — it's just comparison vocab and shouldn't
    # be conflated.
    r"\b("
    r"all\s+(?:the|these|my)\s+(?:slides|lectures|chapters|notebooks|documents|files|sources)"
    r"|across\s+(?:my|the|all)\s+(?:slides|lectures|chapters|notebooks|documents|files|sources)"
    r"|throughout\s+(?:my|the|all|this)\s+(?:course|module|unit|chapter)"
    r"|summari[sz]e\s+the\s+(?:course|module|unit|chapter|lectures?)"
    r")\b",
    re.IGNORECASE,
)
_REASONING_VOCAB = re.compile(
    r"\b(prove|derive|step[- ]by[- ]step|why\s+does|explain\s+why|walk\s+me\s+through|reason(?:ing|s)?\s+about|justify|first[- ]principles?|chain\s+of\s+thought)\b",
    re.IGNORECASE,
)
_SIMPLE_QUESTION = re.compile(
    r"^\s*(what\s+is|define|definition\s+of|who\s+is|when\s+(?:was|did)|where\s+is)\b",
    re.IGNORECASE,
)


def classify_query(text: str) -> ComplexityFinding:
    """Return the complexity class for ``text``.

    Empty inputs default to ``simple`` (the cheapest tier). The router still
    applies its own budget + provider checks on top of this result.
    """
    if not text or not text.strip():
        return ComplexityFinding(
            classification=ComplexityClass.simple,
            score=0.0,
            reasons=("empty",),
        )

    scores: dict[ComplexityClass, float] = {c: 0.0 for c in ComplexityClass}
    reasons: list[str] = []

    # ── code signals ───────────────────────────────────────────────────────
    code_hits = (
        (1 if _CODE_FENCE.search(text) else 0)
        + (1 if _CODE_KEYWORDS.search(text) else 0)
    )
    if code_hits >= 2:
        scores[ComplexityClass.code] += 2.0
        reasons.append("code_block_or_keywords")
    elif code_hits == 1:
        scores[ComplexityClass.code] += 1.0
        reasons.append("code_keyword")

    # ── multi-doc signals ──────────────────────────────────────────────────
    if _MULTI_DOC_VOCAB.search(text):
        scores[ComplexityClass.multi_doc] += 2.0
        reasons.append("multi_doc_vocab")
    if _COMPARISON_VOCAB.search(text):
        scores[ComplexityClass.multi_doc] += 1.0
        reasons.append("comparison_vocab")

    # ── reasoning depth ────────────────────────────────────────────────────
    if _REASONING_VOCAB.search(text):
        scores[ComplexityClass.complex] += 2.0
        reasons.append("reasoning_vocab")

    # ── length signal: longer questions skew complex ───────────────────────
    char_len = len(text)
    if char_len > 600:
        scores[ComplexityClass.complex] += 1.0
        reasons.append("long_query")
    elif char_len > 200:
        scores[ComplexityClass.medium] += 1.0
        reasons.append("medium_length_query")
    else:
        scores[ComplexityClass.simple] += 0.5
        reasons.append("short_query")

    # ── simple-question opener ─────────────────────────────────────────────
    if _SIMPLE_QUESTION.match(text):
        scores[ComplexityClass.simple] += 1.5
        reasons.append("simple_opener")

    # ── multi-sentence questions skew at least medium ──────────────────────
    sentence_count = sum(1 for ch in text if ch in ".?!") or 0
    if sentence_count >= 3:
        scores[ComplexityClass.medium] += 0.5
        reasons.append("multi_sentence")

    # ── decide ─────────────────────────────────────────────────────────────
    winner = _pick_winner(scores)
    return ComplexityFinding(
        classification=winner,
        score=round(scores[winner], 3),
        reasons=tuple(reasons),
    )


# Deterministic tie-break order — the leftmost class wins on equal scores.
_TIE_ORDER: tuple[ComplexityClass, ...] = (
    ComplexityClass.code,
    ComplexityClass.multi_doc,
    ComplexityClass.complex,
    ComplexityClass.medium,
    ComplexityClass.simple,
)


def _pick_winner(scores: dict[ComplexityClass, float]) -> ComplexityClass:
    best = max(scores.values())
    if best <= 0:
        return ComplexityClass.simple
    for candidate in _TIE_ORDER:
        if scores[candidate] == best:
            return candidate
    return ComplexityClass.simple
