"""Safety pass — runs the injection scorer + PII redactor over parsed blocks.

Inputs are ``Block`` (raw text from the parser). Outputs are ``SanitizedBlock``
that carry the original spans + the safety annotations the downstream code
(chunker, retriever, prompt builder) expects.

Two rules:
  * Every output block is tagged ``ContentChannel.untrusted_document`` — the
    prompt builder uses this to wrap chunks in ``<untrusted_document>`` blocks.
  * PII is redacted IN PLACE. The reversible mapping is returned to the caller
    so the production safety agent can persist it to the per-tenant PII vault.
    The thin-slice keeps the mapping in-process.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..agents.contracts import (
    Block,
    ContentChannel,
    SafetyFlag,
    SanitizedBlock,
)
from ..safety.injection import INJECTION_THRESHOLD, score_injection
from ..safety.pii import Redactor


@dataclass(frozen=True)
class SafetyOutcome:
    sanitized: list[SanitizedBlock]
    flags: list[SafetyFlag]
    """Aggregate flags across all blocks. The orchestrator records these on
    the run so admin queues can surface flagged uploads for review."""


def safety_pass(blocks: list[Block]) -> SafetyOutcome:
    redactor = Redactor()
    out: list[SanitizedBlock] = []
    aggregate_flags: set[SafetyFlag] = set()

    for block in blocks:
        injection = score_injection(block.text)
        redacted = redactor.redact(block.text)

        if injection.flagged:
            aggregate_flags.add(SafetyFlag.prompt_injection_suspected)
        if redacted.findings:
            aggregate_flags.add(SafetyFlag.pii_redacted)

        # The reversible mapping is intentionally NOT pushed onto the chunk's
        # ``meta`` field — that would leak the plaintext back into the chunk
        # store. Production wires this into the PII vault.
        out.append(
            SanitizedBlock(
                modality=block.modality,
                text=redacted.text,
                page=block.page,
                slide=block.slide,
                cell=block.cell,
                char_start=block.char_start,
                char_end=block.char_end,
                meta=dict(block.meta),
                channel=ContentChannel.untrusted_document,
                injection_score=injection.score,
                redaction_tokens={},
            )
        )

    return SafetyOutcome(
        sanitized=out,
        flags=sorted(aggregate_flags, key=lambda f: f.value),
    )


__all__ = [
    "INJECTION_THRESHOLD",  # re-exported for callers that surface the threshold
    "SafetyOutcome",
    "safety_pass",
]
