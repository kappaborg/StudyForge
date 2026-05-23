"""PII detection + reversible redaction.

Phase 0 ships a regex-based fallback covering email, US phone, US SSN, and
IPv4 — enough to verify the reversible token contract. Phase 1 swaps in
Presidio (NLP entities). Redaction tokens are stable across re-runs so that
re-indexing the same document does not invalidate citations downstream.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from enum import StrEnum


class PiiKind(StrEnum):
    email = "email"
    phone_us = "phone_us"
    ssn_us = "ssn_us"
    ipv4 = "ipv4"


# Order matters: SSN before phone (numeric overlap on dashes).
_PATTERNS: list[tuple[PiiKind, re.Pattern[str]]] = [
    (PiiKind.email, re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")),
    (PiiKind.ssn_us, re.compile(r"\b\d{3}-\d{2}-\d{4}\b")),
    (PiiKind.phone_us, re.compile(r"\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b")),
    (PiiKind.ipv4, re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")),
]


@dataclass(frozen=True)
class PiiFinding:
    kind: PiiKind
    start: int
    end: int
    token: str
    """Stable replacement token, e.g. ``<PII:email:abc12345>``."""


@dataclass(frozen=True)
class RedactedText:
    text: str
    findings: list[PiiFinding] = field(default_factory=list)


class Redactor:
    """Detect → replace with stable tokens → store reversible mapping.

    The mapping is intentionally not persisted by this class. The caller — the
    Safety/PII agent in production — encrypts the mapping under the per-tenant
    DEK and writes it to the reversible PII vault. Phase 0 keeps the mapping
    in-process so tests can verify reversibility without crypto wiring.
    """

    def __init__(self) -> None:
        self._vault: dict[str, str] = {}

    def redact(self, text: str) -> RedactedText:
        if not text:
            return RedactedText(text="", findings=[])

        findings: list[PiiFinding] = []
        # Collect non-overlapping matches by walking patterns in priority order.
        consumed: list[tuple[int, int]] = []
        for kind, pattern in _PATTERNS:
            for match in pattern.finditer(text):
                start, end = match.start(), match.end()
                if _overlaps(consumed, start, end):
                    continue
                consumed.append((start, end))
                token = self._token_for(kind, text[start:end])
                self._vault[token] = text[start:end]
                findings.append(PiiFinding(kind=kind, start=start, end=end, token=token))

        findings.sort(key=lambda f: f.start)

        # Apply replacements right-to-left so indices stay valid.
        redacted = text
        for f in reversed(findings):
            redacted = redacted[: f.start] + f.token + redacted[f.end :]
        return RedactedText(text=redacted, findings=findings)

    def reverse(self, token: str) -> str | None:
        return self._vault.get(token)

    @staticmethod
    def _token_for(kind: PiiKind, value: str) -> str:
        digest = hashlib.sha256(value.encode("utf-8")).hexdigest()[:8]
        return f"<PII:{kind.value}:{digest}>"


def _overlaps(consumed: list[tuple[int, int]], start: int, end: int) -> bool:
    for cstart, cend in consumed:
        if start < cend and cstart < end:
            return True
    return False
