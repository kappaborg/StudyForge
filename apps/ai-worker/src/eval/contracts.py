"""Wire types for the eval harness.

Golden cases are JSONL; one case per line. Every field is required to keep
authoring discipline tight.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class GoldenChunk:
    """A pre-retrieved chunk supplied to the tutor agent for the eval. We
    avoid running real retrieval inside the eval so each case is fully
    deterministic and the harness pinpoints prompt regressions, not
    retrieval regressions."""

    chunk_id: str
    content: str
    score: float = 0.9
    page: int | None = 1
    doc_id: str = "golden-doc"
    version_id: str = "golden-version"


@dataclass(frozen=True)
class GoldenCase:
    """One golden case. ``expect_refusal`` and ``expected_chunks`` are
    mutually exclusive: a refusal case has no citation expectations, a
    cited case lists which retrieved chunks SHOULD appear in the citation
    set."""

    case_id: str
    query: str
    chunks: tuple[GoldenChunk, ...] = ()
    expect_refusal: bool = False
    # Subset relation: every id here MUST appear in the response's citations.
    expected_chunks: tuple[str, ...] = ()
    # Banned phrases — text in the response MUST NOT contain any of these.
    must_not_contain: tuple[str, ...] = ()
    # Optional model-output override (used when the agent is run against a
    # FakeProvider that returns this exact text instead of calling a real LLM).
    model_response: str | None = None
    notes: str | None = None


@dataclass(frozen=True)
class EvalResult:
    """Result of running ONE golden case through the agent + evaluator."""

    case_id: str
    passed: bool
    reasons: tuple[str, ...] = field(default_factory=tuple)
    """Empty when ``passed`` is True. One or more failure reasons otherwise."""
    refusal: bool = False
    citation_count: int = 0
    # Ragas-lite continuous scores. Empty dict for structural-only runs.
    scores: dict[str, float] = field(default_factory=dict)


@dataclass(frozen=True)
class Threshold:
    """Per-prompt gate. CI fails when ``pass_rate`` drops below
    ``min_pass_rate`` OR when any score in ``min_scores`` averages below
    its threshold across the golden set."""

    prompt_id: str
    min_pass_rate: float = 1.0
    """Default 1.0 — every case must pass. Lower bars (e.g. 0.95) are
    explicit choices documented in a PR."""
    min_scores: dict[str, float] = field(default_factory=dict)
    """Per-metric average floor. Example: ``{"citation_validity": 0.95,
    "context_precision": 0.80}``. Empty dict skips score gating."""


@dataclass(frozen=True)
class EvalReport:
    """Aggregate result over a full golden set."""

    prompt_id: str
    total: int
    passed: int
    failed: int
    pass_rate: float
    threshold: Threshold
    results: tuple[EvalResult, ...]

    @property
    def average_scores(self) -> dict[str, float]:
        """Mean of each scorer's value across all cases."""
        if not self.results:
            return {}
        totals: dict[str, float] = {}
        counts: dict[str, int] = {}
        for r in self.results:
            for k, v in r.scores.items():
                totals[k] = totals.get(k, 0.0) + v
                counts[k] = counts.get(k, 0) + 1
        return {k: round(totals[k] / counts[k], 4) for k in totals}

    @property
    def meets_threshold(self) -> bool:
        if self.pass_rate < self.threshold.min_pass_rate:
            return False
        avg = self.average_scores
        for metric, floor in self.threshold.min_scores.items():
            if avg.get(metric, 0.0) < floor:
                return False
        return True

    def to_jsonable(self) -> dict[str, Any]:
        return {
            "prompt_id": self.prompt_id,
            "total": self.total,
            "passed": self.passed,
            "failed": self.failed,
            "pass_rate": round(self.pass_rate, 4),
            "threshold": self.threshold.min_pass_rate,
            "min_scores": self.threshold.min_scores,
            "average_scores": self.average_scores,
            "meets_threshold": self.meets_threshold,
            "results": [
                {
                    "case_id": r.case_id,
                    "passed": r.passed,
                    "reasons": list(r.reasons),
                    "refusal": r.refusal,
                    "citation_count": r.citation_count,
                    "scores": r.scores,
                }
                for r in self.results
            ],
        }
