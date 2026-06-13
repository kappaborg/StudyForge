"""Eval-harness CLI.

Run as:

    uv run python -m src.eval.cli --prompt tutor.answer.v1 \
                                  --golden packages/eval-harness/golden/tutor.answer.v1/cases.jsonl

Returns exit code:

    0  — all cases pass and the pass-rate meets the threshold
    1  — one or more cases fail OR the pass-rate is below the threshold
    2  — invocation error (missing file, bad CLI args)

The CI workflow runs this on every PR that touches an agent or a prompt;
failure blocks the merge.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import sys
from pathlib import Path

from .contracts import Evaluator, Threshold
from .runner import EvalRunner

DEFAULT_GOLDEN_ROOT = Path("packages/eval-harness/golden")

RAGAS_METRICS = ("faithfulness", "answer_relevance", "context_recall")


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="studyforge-eval")
    parser.add_argument(
        "--prompt",
        required=True,
        help="Prompt id, e.g. tutor.answer.v1",
    )
    parser.add_argument(
        "--golden",
        help="Path to the golden-set JSONL. Default: packages/eval-harness/golden/<prompt>/cases.jsonl",
    )
    parser.add_argument(
        "--min-pass-rate",
        type=float,
        default=1.0,
        help="Required pass-rate. Default 1.0 (every case passes).",
    )
    parser.add_argument(
        "--min-citation-validity",
        type=float,
        default=0.0,
        help="Average citation_validity floor (0..1). 0 disables gating.",
    )
    parser.add_argument(
        "--min-context-precision",
        type=float,
        default=0.0,
        help="Average context_precision floor (0..1). 0 disables gating.",
    )
    parser.add_argument(
        "--min-refusal-consistency",
        type=float,
        default=0.0,
        help="Average refusal_consistency floor (0..1). 0 disables gating.",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Emit the report as JSON instead of human-readable text.",
    )
    parser.add_argument(
        "--mode",
        choices=("structural", "ragas"),
        default=os.environ.get("EVAL_MODE", "structural"),
        help=(
            "structural (default): deterministic §5 contract check + ragas-lite "
            "lexical scores, no LLM. ragas: same + one LLM-judge call per case "
            "scoring faithfulness / answer_relevance / context_recall. Ragas mode "
            "requires at least one provider key in the env."
        ),
    )
    parser.add_argument(
        "--judge-model",
        default=None,
        help="Judge model id (default: EVAL_JUDGE_MODEL env or gemini-2.0-flash-exp).",
    )
    parser.add_argument(
        "--judge-provider",
        default=None,
        help="Explicit provider id for the judge (default: first available).",
    )
    for metric in RAGAS_METRICS:
        parser.add_argument(
            f"--min-{metric.replace('_', '-')}",
            type=float,
            default=0.0,
            help=f"Average {metric} floor (0..1) — only enforced in ragas mode.",
        )
    return parser


def _default_golden_path(prompt_id: str) -> Path:
    # Walk upward from this file until we find the repo root (the directory
    # containing ``packages/eval-harness``). Avoids hard-coding repo layout.
    here = Path(__file__).resolve()
    for parent in here.parents:
        if (parent / DEFAULT_GOLDEN_ROOT).exists():
            return parent / DEFAULT_GOLDEN_ROOT / prompt_id / "cases.jsonl"
    raise FileNotFoundError(
        f"could not locate {DEFAULT_GOLDEN_ROOT} from {here}; pass --golden explicitly"
    )


async def _run(prompt_id: str, golden_path: Path, threshold: Threshold) -> int:
    runner = EvalRunner()
    report = await runner.run_path(
        prompt_id=prompt_id,
        golden_path=golden_path,
        threshold=threshold,
    )
    return report.passed, report.failed, report  # type: ignore[return-value]


def _format_human(report) -> str:  # type: ignore[no-untyped-def]
    lines = [
        f"prompt: {report.prompt_id}",
        f"golden cases: {report.total}",
        f"passed: {report.passed}",
        f"failed: {report.failed}",
        f"pass_rate: {report.pass_rate:.2%} (threshold {report.threshold.min_pass_rate:.2%})",
    ]
    if report.average_scores:
        lines.append("")
        lines.append("ragas-lite averages:")
        for metric, value in sorted(report.average_scores.items()):
            floor = report.threshold.min_scores.get(metric)
            tail = f" (floor {floor:.2f})" if floor is not None else ""
            lines.append(f"  - {metric}: {value:.4f}{tail}")
    lines.append("")
    lines.append(f"meets_threshold: {report.meets_threshold}")
    if report.failed > 0:
        lines.append("")
        lines.append("failures:")
        for r in report.results:
            if r.passed:
                continue
            lines.append(f"  - {r.case_id}: {', '.join(r.reasons)}")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    args = _build_parser().parse_args(argv)

    try:
        golden_path = Path(args.golden) if args.golden else _default_golden_path(args.prompt)
    except FileNotFoundError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    if not golden_path.exists():
        print(f"error: golden set not found at {golden_path}", file=sys.stderr)
        return 2

    min_scores: dict[str, float] = {}
    if args.min_citation_validity > 0:
        min_scores["citation_validity"] = args.min_citation_validity
    if args.min_context_precision > 0:
        min_scores["context_precision"] = args.min_context_precision
    if args.min_refusal_consistency > 0:
        min_scores["refusal_consistency"] = args.min_refusal_consistency

    # Ragas-only thresholds. Stay zero (i.e. unenforced) in structural mode.
    if args.mode == "ragas":
        for metric in RAGAS_METRICS:
            floor = getattr(args, f"min_{metric}")
            if floor > 0:
                min_scores[metric] = floor

    threshold = Threshold(
        prompt_id=args.prompt,
        min_pass_rate=args.min_pass_rate,
        min_scores=min_scores,
    )

    try:
        evaluator = _build_evaluator(args)
    except RuntimeError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    async def _main() -> int:
        report = await EvalRunner(evaluator=evaluator).run_path(
            prompt_id=args.prompt,
            golden_path=golden_path,
            threshold=threshold,
        )
        if args.json:
            print(json.dumps(report.to_jsonable(), indent=2))
        else:
            print(_format_human(report))
        return 0 if report.meets_threshold else 1

    return asyncio.run(_main())


def _build_evaluator(args: argparse.Namespace) -> Evaluator | None:
    """Return the evaluator chosen by ``args.mode``. Raises RuntimeError
    on misconfigured ragas runs (the failure surface for "EVAL_MODE=ragas
    is set but no provider key is in the env")."""
    if args.mode == "structural":
        return None  # EvalRunner default

    # Local imports keep the structural path free of LLM-router weight.
    from ..llm.registry import ProviderCredentials, ProviderRegistry
    from .llm_judge import LlmJudge, judge_model_from_env
    from .ragas import RagasEvaluator

    creds = ProviderCredentials(
        groq_api_key=os.environ.get("GROQ_API_KEY"),
        gemini_api_key=os.environ.get("GEMINI_API_KEY"),
        openai_api_key=os.environ.get("OPENAI_API_KEY"),
        anthropic_api_key=os.environ.get("ANTHROPIC_API_KEY"),
        openrouter_api_key=os.environ.get("OPENROUTER_API_KEY"),
        cerebras_api_key=os.environ.get("CEREBRAS_API_KEY"),
        together_api_key=os.environ.get("TOGETHER_API_KEY"),
        fireworks_api_key=os.environ.get("FIREWORKS_API_KEY"),
    )
    registry = ProviderRegistry(creds)
    available = registry.available_provider_ids()
    if not available:
        raise RuntimeError(
            "ragas mode requires a provider key in the env (one of "
            "GROQ_API_KEY / GEMINI_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY / "
            "OPENROUTER_API_KEY / CEREBRAS_API_KEY / TOGETHER_API_KEY / "
            "FIREWORKS_API_KEY), but none are set"
        )

    provider_id = args.judge_provider or _pick_judge_provider(available)
    if provider_id not in available:
        raise RuntimeError(
            f"--judge-provider {provider_id!r} requested, but only "
            f"{sorted(available)} are configured"
        )

    judge = LlmJudge(
        provider=registry.get(provider_id),
        model=args.judge_model or judge_model_from_env(),
    )
    return RagasEvaluator(judge=judge)


def _pick_judge_provider(available: list[str]) -> str:
    """Pick a judge from what's available. Gemini Flash → Groq → first
    configured. Gemini first because it's the largest free tier; Groq
    next because it's the fastest."""
    for preferred in ("gemini", "groq", "openrouter", "openai", "anthropic"):
        if preferred in available:
            return preferred
    return next(iter(sorted(available)))


if __name__ == "__main__":
    raise SystemExit(main())
