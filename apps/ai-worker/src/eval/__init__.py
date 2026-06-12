"""Eval harness.

Quality regression detection for agent prompts. The Phase-1 #8 implementation
ships the *structural* evaluator — deterministic, no LLM calls — which covers
the citation-enforcement contract from §5 and the no-banned-phrase rule from
§6 golden-set authoring. Ragas integration lives behind ``EVAL_MODE=ragas``
and is wired in Phase 1 mid; it requires a configured LLM-judge provider.

CI gate (``.github/workflows/ci.yml``) runs ``python -m src.eval.cli`` on
every PR that touches a prompt source or an agent module. Non-zero exit
fails the workflow.

Public surface:

  * ``GoldenCase`` / ``EvalResult`` / ``EvalReport`` — typed contracts.
  * ``load_golden_set`` — JSONL loader.
  * ``StructuralEvaluator`` — the deterministic evaluator that runs the agent
    and checks the §5 invariants.
  * ``EvalRunner`` — orchestrates load → run → evaluate → aggregate.
"""

from .contracts import (
    EvalReport as EvalReport,
)
from .contracts import (
    EvalResult as EvalResult,
)
from .contracts import (
    GoldenCase as GoldenCase,
)
from .contracts import (
    Threshold as Threshold,
)
from .loader import load_golden_set as load_golden_set
from .runner import EvalRunner as EvalRunner
from .structural import StructuralEvaluator as StructuralEvaluator
