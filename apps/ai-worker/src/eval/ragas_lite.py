"""Ragas-lite: deterministic scorers for the tutor eval gate.

True Ragas runs an LLM judge over each claim — expensive, non-deterministic,
and a hard CI signal to gate on. The lite version computes three numbers
that catch most regressions and stay reproducible:

  * ``citation_validity``  — fraction of cited chunks that exist in the
    supplied chunk set (catches hallucinated chunk_ids in the model output)
  * ``context_precision``  — fraction of supplied chunks that overlap
    lexically with the query (catches retrieval drift; proxy for "did we
    retrieve relevant material")
  * ``refusal_consistency`` — 1.0 when the refusal flag matches the
    expected_refusal on the case, 0.0 otherwise

The CLI gates on per-metric minimums. Full LLM-judge Ragas can layer on
top of this — these three are necessary, not sufficient.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from ..agents.contracts import TutorOutput
from .contracts import GoldenCase

_TOKEN_RE = re.compile(r"[A-Za-z0-9]+")
_STOPWORDS = {
    "a", "an", "the", "and", "or", "of", "in", "on", "for", "is", "are",
    "was", "were", "be", "with", "to", "by", "as", "at", "from", "this",
    "that", "what", "how", "why", "when", "where", "who",
}


@dataclass(frozen=True)
class RagasLiteScores:
    citation_validity: float
    context_precision: float
    refusal_consistency: float

    def to_dict(self) -> dict[str, float]:
        return {
            "citation_validity": round(self.citation_validity, 4),
            "context_precision": round(self.context_precision, 4),
            "refusal_consistency": round(self.refusal_consistency, 4),
        }


def score_case(case: GoldenCase, out: TutorOutput) -> RagasLiteScores:
    """Compute the three lite metrics for one (case, agent_output) pair."""
    supplied_ids = {c.chunk_id for c in case.chunks}
    cited_ids = [c.chunk_id for c in out.citations]
    if cited_ids:
        valid = sum(1 for c in cited_ids if c in supplied_ids)
        citation_validity = valid / len(cited_ids)
    elif case.expect_refusal:
        # No citations expected; a refusal is "valid" by definition.
        citation_validity = 1.0
    else:
        citation_validity = 0.0

    query_terms = _tokens(case.query)
    if not query_terms or not case.chunks:
        context_precision = 0.0 if case.chunks else 1.0
    else:
        hits = 0
        for chunk in case.chunks:
            chunk_terms = _tokens(chunk.content)
            if query_terms & chunk_terms:
                hits += 1
        context_precision = hits / len(case.chunks)

    refusal_consistency = 1.0 if out.refusal == case.expect_refusal else 0.0

    return RagasLiteScores(
        citation_validity=citation_validity,
        context_precision=context_precision,
        refusal_consistency=refusal_consistency,
    )


def _tokens(text: str) -> set[str]:
    return {
        t.lower() for t in _TOKEN_RE.findall(text)
        if t.lower() not in _STOPWORDS and len(t) >= 3
    }


__all__ = ["RagasLiteScores", "score_case"]
