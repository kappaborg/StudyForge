"""Eval runner.

Loads a golden set, evaluates every case, aggregates pass-rate, applies the
per-prompt threshold. The CLI consumes this directly; pytest cases consume
it through the same entrypoint.
"""

from __future__ import annotations

import logging
from collections.abc import Sequence
from pathlib import Path

from .contracts import EvalReport, Evaluator, GoldenCase, Threshold
from .loader import load_golden_set
from .structural import StructuralEvaluator

log = logging.getLogger(__name__)


class EvalRunner:
    def __init__(self, *, evaluator: Evaluator | None = None) -> None:
        self._evaluator: Evaluator = evaluator or StructuralEvaluator()

    async def run_path(
        self,
        *,
        prompt_id: str,
        golden_path: str | Path,
        threshold: Threshold | None = None,
    ) -> EvalReport:
        cases = load_golden_set(golden_path)
        return await self.run(prompt_id=prompt_id, cases=cases, threshold=threshold)

    async def run(
        self,
        *,
        prompt_id: str,
        cases: Sequence[GoldenCase],
        threshold: Threshold | None = None,
    ) -> EvalReport:
        results = []
        for case in cases:
            result = await self._evaluator.evaluate(case)
            results.append(result)
            if not result.passed:
                log.warning(
                    "eval.fail prompt=%s case=%s reasons=%s",
                    prompt_id,
                    result.case_id,
                    list(result.reasons),
                )
        total = len(results)
        passed = sum(1 for r in results if r.passed)
        failed = total - passed
        pass_rate = (passed / total) if total > 0 else 0.0
        return EvalReport(
            prompt_id=prompt_id,
            total=total,
            passed=passed,
            failed=failed,
            pass_rate=pass_rate,
            threshold=threshold or Threshold(prompt_id=prompt_id),
            results=tuple(results),
        )
