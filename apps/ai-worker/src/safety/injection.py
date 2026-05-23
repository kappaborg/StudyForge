"""Heuristic prompt-injection scorer.

Deterministic, pattern-based. Runs on every block immediately after extraction
(Safety/PII agent — §5). The score is *one* signal; channel separation in
``prompt_builder`` is the load-bearing defense. Scores ≥ ``INJECTION_THRESHOLD``
flip ``SanitizedBlock.flags`` to include ``prompt_injection_suspected`` and
surface the block in the abuse queue.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

INJECTION_THRESHOLD = 0.7

# Each pattern carries a weight in [0, 1]; total score is min(1, sum(weights of
# matches)). Patterns are intentionally simple — sophisticated detection lives
# in Phase 1 (Presidio + a fine-tuned classifier).
_PATTERNS: list[tuple[str, re.Pattern[str], float]] = [
    (
        "instruction_override",
        re.compile(
            r"\b(ignore|disregard|forget|bypass)\s+(?:(?:the|all|any|your|previous|prior|above|earlier)\s+)+(?:instructions?|rules?|system\s+prompt|guardrails?|policy)\b",
            re.IGNORECASE,
        ),
        0.7,
    ),
    (
        "persona_override",
        re.compile(
            r"\b(you\s+are\s+now|act\s+as|pretend\s+to\s+be|roleplay\s+as|switch\s+to|become)\s+",
            re.IGNORECASE,
        ),
        0.5,
    ),
    (
        "system_label",
        re.compile(r"^\s*(system|developer|assistant)\s*:\s*", re.IGNORECASE | re.MULTILINE),
        0.3,
    ),
    (
        "untrusted_tag_escape",
        re.compile(r"</?untrusted_document\b", re.IGNORECASE),
        0.9,
    ),
    (
        "tool_injection",
        re.compile(r"<\s*tool_use\b|\bfunction\s*\(.*?\)\s*=>", re.IGNORECASE),
        0.4,
    ),
    (
        "bidi_marks",
        re.compile("[‪-‮⁦-⁩]"),
        0.8,
    ),
    (
        "zero_width",
        re.compile("[​‌‍⁠﻿]{3,}"),
        0.4,
    ),
    (
        "base64_blob",
        re.compile(r"(?:[A-Za-z0-9+/]{4}){50,}={0,2}"),
        0.3,
    ),
    (
        "secret_prompt",
        re.compile(
            r"\b(reveal|leak|exfiltrate|show\s+me|print|output|dump)\s+(?:the\s+|your\s+)?(system\s+prompt|secret|password|api[-_ ]?key|guardrails?|instructions?)\b",
            re.IGNORECASE,
        ),
        0.6,
    ),
]


@dataclass(frozen=True)
class InjectionFinding:
    score: float
    flagged: bool
    reasons: list[str] = field(default_factory=list)


def score_injection(text: str) -> InjectionFinding:
    """Score a single text blob. Deterministic — same input, same output."""
    if not text:
        return InjectionFinding(score=0.0, flagged=False, reasons=[])

    reasons: list[str] = []
    total = 0.0
    for name, pattern, weight in _PATTERNS:
        if pattern.search(text):
            reasons.append(name)
            total += weight

    score = min(1.0, total)
    score = round(score, 4)
    return InjectionFinding(
        score=score,
        flagged=score >= INJECTION_THRESHOLD,
        reasons=reasons,
    )
