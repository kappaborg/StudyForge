"""LLM-judge eval mode — the real Ragas-style semantic scorer.

The ``ragas_lite`` module computes deterministic lexical proxies
(citation_validity / context_precision / refusal_consistency). Those
catch hard regressions but miss the soft kind: an answer that's
correctly-cited but doesn't actually answer the question, or
hallucinates a claim that isn't in the chunks.

This module runs ONE LLM judge call per case, asking the judge to score
three Ragas-style metrics on a 0..1 scale:

* ``faithfulness``      — every claim in the answer is grounded in the chunks
* ``answer_relevance``  — the answer actually addresses the query
* ``context_recall``    — the supplied chunks cover what's needed to answer

Activated by ``EVAL_MODE=ragas`` (or ``--mode ragas`` on the CLI). Needs
exactly one provider-key env var (any of the §13.1 set). When the env
flag is set but no provider is configured, the CLI fails loudly — that's
a misconfigured run, not a missing optional feature.
"""

from __future__ import annotations

import json
import logging
import os
import re
from dataclasses import dataclass

from ..agents.contracts import TutorOutput
from ..llm.contracts import ChannelMessage, LLMProvider, LLMRequest
from .contracts import GoldenCase

log = logging.getLogger(__name__)

DEFAULT_JUDGE_MODEL = "gemini-2.0-flash-exp"
"""Defaults to Gemini Flash because it has the largest free tier and the
strongest instruction-following at the price point. Override via
``EVAL_JUDGE_MODEL`` env or ``--judge-model`` CLI."""


@dataclass(frozen=True)
class RagasFullScores:
    faithfulness: float
    answer_relevance: float
    context_recall: float
    reasoning: str = ""

    def to_dict(self) -> dict[str, float]:
        return {
            "faithfulness": round(self.faithfulness, 4),
            "answer_relevance": round(self.answer_relevance, 4),
            "context_recall": round(self.context_recall, 4),
        }


_JUDGE_SYSTEM = (
    "You are an evaluator scoring a tutor's answer against the question and the "
    "source passages it was given. Score every metric on a 0.0 to 1.0 scale where "
    "0.0 is the worst possible result and 1.0 is the best. Be strict: a 0.7 means "
    "noticeable problems, a 0.9 means a tiny defect, 1.0 means flawless. Return ONLY "
    "JSON in the exact shape requested, no markdown fence, no commentary."
)


def _build_judge_prompt(case: GoldenCase, out: TutorOutput) -> str:
    chunks_block = "\n\n".join(
        f"[chunk:{c.chunk_id}]\n{c.content.strip()}" for c in case.chunks
    ) or "(no chunks supplied)"

    citations_block = (
        ", ".join(c.chunk_id for c in out.citations) or "(none)"
    )

    refusal_note = (
        " The tutor refused to answer."
        if out.refusal
        else ""
    )

    return (
        f"QUESTION:\n{case.query}\n\n"
        f"SOURCE PASSAGES:\n{chunks_block}\n\n"
        f"TUTOR ANSWER:\n{out.text or '(empty)'}\n\n"
        f"TUTOR CITATIONS: {citations_block}.{refusal_note}\n\n"
        "Score on three metrics:\n"
        "1. faithfulness: 1.0 if every factual claim in the answer is supported by "
        "the source passages; lower as claims drift from sources; 0.0 for fabricated "
        "content. A refusal that is justified by missing sources scores 1.0.\n"
        "2. answer_relevance: 1.0 if the answer directly addresses the question; "
        "lower for tangential answers; 0.0 for unrelated. A justified refusal scores "
        "1.0; an unjustified refusal scores 0.0.\n"
        "3. context_recall: 1.0 if the supplied passages contain enough information "
        "to answer the question; lower for partial coverage; 0.0 for none. "
        "Independent of what the tutor did with them.\n\n"
        'Respond with exactly: {"faithfulness": <0..1>, "answer_relevance": <0..1>, '
        '"context_recall": <0..1>, "reasoning": "<one sentence>"}'
    )


_JSON_FENCE = re.compile(r"```(?:json)?\s*(\{.*?\})\s*```", re.DOTALL)
_BARE_OBJECT = re.compile(r"\{[^{}]*\}", re.DOTALL)


def _extract_json_object(text: str) -> dict[str, object]:
    """Pull a JSON object out of the judge response.

    Some providers wrap responses in ```json fences even when told not to;
    others prepend a sentence. We try direct parse first, then a fenced
    block, then the first bare ``{...}`` we can find. Any failure raises
    ``ValueError`` so the caller can decide whether to retry / fall back.
    """
    stripped = text.strip()
    try:
        result = json.loads(stripped)
        if isinstance(result, dict):
            return result
    except json.JSONDecodeError:
        pass

    fence = _JSON_FENCE.search(text)
    if fence:
        result = json.loads(fence.group(1))
        if isinstance(result, dict):
            return result

    bare = _BARE_OBJECT.search(text)
    if bare:
        result = json.loads(bare.group(0))
        if isinstance(result, dict):
            return result

    raise ValueError(f"judge response did not contain a JSON object: {text!r}")


def _clamp(value: object, default: float = 0.0) -> float:
    """Coerce a judge score into [0.0, 1.0]. Non-numeric → ``default``."""
    try:
        v = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default
    if v != v:  # NaN check without importing math.isnan
        return default
    return max(0.0, min(1.0, v))


class LlmJudge:
    """One LLM-judge call per golden case. Stateless; safe to share."""

    def __init__(self, provider: LLMProvider, model: str = DEFAULT_JUDGE_MODEL) -> None:
        self._provider = provider
        self._model = model

    async def score(self, case: GoldenCase, out: TutorOutput) -> RagasFullScores:
        prompt = _build_judge_prompt(case, out)
        request = LLMRequest(
            model=self._model,
            messages=[
                ChannelMessage(role="system", content=_JUDGE_SYSTEM),
                ChannelMessage(role="user", content=prompt),
            ],
            max_output_tokens=256,
            temperature=0.0,
        )
        response = await self._provider.complete(request)

        try:
            payload = _extract_json_object(response.text)
        except (ValueError, json.JSONDecodeError) as exc:
            log.warning(
                "judge.parse_failed case=%s model=%s error=%s text=%r",
                case.case_id, self._model, exc, response.text[:200],
            )
            # Score as 0 on parse failure — the judge produced nonsense,
            # so the case can't be considered passing the LLM bar.
            return RagasFullScores(
                faithfulness=0.0,
                answer_relevance=0.0,
                context_recall=0.0,
                reasoning="judge response did not parse",
            )

        reasoning = payload.get("reasoning")
        return RagasFullScores(
            faithfulness=_clamp(payload.get("faithfulness")),
            answer_relevance=_clamp(payload.get("answer_relevance")),
            context_recall=_clamp(payload.get("context_recall")),
            reasoning=str(reasoning) if reasoning is not None else "",
        )


def judge_model_from_env() -> str:
    """Resolve the judge model id, honoring ``EVAL_JUDGE_MODEL``."""
    return os.environ.get("EVAL_JUDGE_MODEL", DEFAULT_JUDGE_MODEL)


__all__ = [
    "DEFAULT_JUDGE_MODEL",
    "LlmJudge",
    "RagasFullScores",
    "judge_model_from_env",
]
