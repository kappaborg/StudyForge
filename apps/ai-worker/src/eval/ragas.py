"""Ragas evaluator — runs the structural check first, then layers the
LLM-judge metrics on top.

Why structural-first: the §5 citation-enforcement contract is a hard
yes/no gate (refusal correctness, mandatory chunk citations, banned-
phrase scan). The LLM judge can't replace that — it's a continuous
quality signal. So a Ragas run is structural pass/fail AND llm-judge
score: a case fails the gate if either layer fails its threshold.

When ``LlmJudge`` is unavailable (no provider configured), the CLI
fails loudly rather than silently degrading. That's the difference
between this evaluator and ``StructuralEvaluator`` — ragas mode is
opt-in, and "ragas mode without a judge" is always a config bug.
"""

from __future__ import annotations

import logging
import os

from .contracts import EvalResult, GoldenCase
from .llm_judge import LlmJudge
from .structural import StructuralEvaluator

log = logging.getLogger(__name__)


class RagasEvaluator:
    def __init__(
        self,
        *,
        judge: LlmJudge,
        structural: StructuralEvaluator | None = None,
    ) -> None:
        self._structural = structural or StructuralEvaluator()
        self._judge = judge

    async def evaluate(self, case: GoldenCase) -> EvalResult:
        # Step 1 — run the deterministic structural check. This also runs
        # the tutor agent (with a scripted provider) and computes the
        # ragas-lite lexical scores. We layer judge scores on top.
        base = await self._structural.evaluate(case)

        # We need the actual TutorOutput to feed the judge. The structural
        # evaluator doesn't return it, so we re-run the agent here via the
        # same scripted-provider machinery. That's a small duplicate cost
        # acceptable for an offline eval gate.
        from ..agents.contracts import TutorInput
        from ..agents.tutor import TutorAgent
        from .structural import _ScriptedProvider, _to_retrieved  # local import

        if case.expect_refusal:
            scripted = _ScriptedProvider(case.model_response or "_unused_")
        elif case.model_response is not None:
            scripted = _ScriptedProvider(case.model_response)
        else:
            cite_tags = " ".join(f"[chunk:{c.chunk_id}]" for c in case.chunks)
            scripted = _ScriptedProvider(f"Answer based on the materials. {cite_tags}")

        agent = TutorAgent(provider=scripted)
        out = await agent.run(
            TutorInput(
                session_id="00000000-0000-0000-0000-000000000000",
                user_id="11111111-1111-1111-1111-111111111111",
                query=case.query,
                retrieved_chunks=[_to_retrieved(c) for c in case.chunks],
            )
        )

        # Step 2 — LLM-judge scores.
        judge_scores = await self._judge.score(case, out)

        # Merge: structural's lexical scores + LLM judge's semantic scores.
        merged = dict(base.scores)
        merged.update(judge_scores.to_dict())
        if judge_scores.reasoning:
            log.info(
                "judge.case case=%s reasoning=%s scores=%s",
                case.case_id,
                judge_scores.reasoning,
                judge_scores.to_dict(),
            )

        return EvalResult(
            case_id=base.case_id,
            passed=base.passed,
            reasons=base.reasons,
            refusal=base.refusal,
            citation_count=base.citation_count,
            scores=merged,
        )


def is_ragas_mode_enabled() -> bool:
    """``EVAL_MODE=ragas`` toggles the LLM-judge path in CI / CLI."""
    return os.environ.get("EVAL_MODE", "").lower() == "ragas"


__all__ = ["RagasEvaluator", "is_ragas_mode_enabled"]
