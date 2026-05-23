"""Structural evaluator — the deterministic, no-LLM eval path.

Verifies the §5 citation-enforcement contract end-to-end on each golden case:

  * If ``expect_refusal`` is true, the agent MUST return ``refusal=True``
    with an empty citation set.
  * Otherwise the agent MUST return ``refusal=False`` with at least one
    citation that maps to a real chunk.
  * Every id in ``expected_chunks`` MUST appear in the response's citation
    set.
  * No phrase in ``must_not_contain`` may appear in the response text.

This evaluator does not call any LLM — the agent is invoked against a
``FakeProvider`` that returns the ``model_response`` field from the case (or
a default citation-tagged response when omitted). Ragas-style judging
(``EVAL_MODE=ragas``) is a separate evaluator wired in Phase 1 mid.
"""

from __future__ import annotations

from collections.abc import AsyncIterator

from ..agents.contracts import RetrievedChunk, TutorInput
from ..agents.tutor import TutorAgent
from .ragas_lite import score_case
from ..llm.contracts import (
    LLMProvider,
    LLMRequest,
    LLMResponse,
    LLMStreamChunk,
    LLMUsage,
)
from .contracts import EvalResult, GoldenCase, GoldenChunk


class _ScriptedProvider(LLMProvider):
    """In-process provider that returns a fixed response. Used by the
    structural evaluator so eval cases never depend on a real LLM."""

    id: str = "scripted"
    supports_prompt_cache: bool = False
    supports_streaming: bool = False
    context_window_tokens: int = 8000

    def __init__(self, response_text: str) -> None:
        self._text = response_text

    async def complete(self, req: LLMRequest) -> LLMResponse:
        return LLMResponse(
            text=self._text,
            finish_reason="stop",
            usage=LLMUsage(tokens_in=0, tokens_out=0, cached_tokens_in=0, cache_hit=False),
            model=req.model,
            provider_id="scripted",
        )

    def stream(self, req: LLMRequest) -> AsyncIterator[LLMStreamChunk]:  # pragma: no cover
        raise NotImplementedError("scripted provider does not stream")

    async def ping(self) -> dict[str, object]:  # pragma: no cover
        return {"ok": True, "latency_ms": 0}


class StructuralEvaluator:
    """Runs the §5 contract checks against one golden case."""

    def __init__(self) -> None:
        pass

    async def evaluate(self, case: GoldenCase) -> EvalResult:
        provider: LLMProvider | None
        if case.expect_refusal:
            # Refusal cases don't call the provider at all (no supportive
            # chunks → tutor refuses without an LLM call). Wire a provider
            # anyway so the path that *would* fire is realistic.
            provider = _ScriptedProvider(case.model_response or "_unused_")
        elif case.model_response is not None:
            provider = _ScriptedProvider(case.model_response)
        else:
            # Default response cites every supplied chunk in order so cited
            # cases pass without authors having to spell out the text.
            cite_tags = " ".join(f"[chunk:{c.chunk_id}]" for c in case.chunks)
            provider = _ScriptedProvider(f"Answer based on the materials. {cite_tags}")

        agent = TutorAgent(provider=provider)
        payload = TutorInput(
            session_id="00000000-0000-0000-0000-000000000000",
            user_id="11111111-1111-1111-1111-111111111111",
            query=case.query,
            retrieved_chunks=[_to_retrieved(c) for c in case.chunks],
        )
        out = await agent.run(payload)

        reasons: list[str] = []

        if case.expect_refusal:
            if not out.refusal:
                reasons.append("expected refusal but agent returned an answer")
            if out.citations:
                reasons.append(
                    f"refusal must carry zero citations; got {len(out.citations)}"
                )
            return EvalResult(
                case_id=case.case_id,
                passed=not reasons,
                reasons=tuple(reasons),
                refusal=out.refusal,
                citation_count=len(out.citations),
                scores=score_case(case, out).to_dict(),
            )

        # Cited path.
        if out.refusal:
            reasons.append("expected cited answer but agent refused")
        if not out.citations and not out.refusal:
            # Defensive — the agent should refuse if no citations survived;
            # surface anyway in case the contract regresses.
            reasons.append("response has zero citations")

        actual_chunk_ids = {c.chunk_id for c in out.citations}
        missing = [
            expected for expected in case.expected_chunks if expected not in actual_chunk_ids
        ]
        if missing:
            reasons.append(f"missing expected citations: {missing}")

        text_lower = out.text.lower()
        offending = [
            phrase
            for phrase in case.must_not_contain
            if phrase.lower() in text_lower
        ]
        if offending:
            reasons.append(f"banned phrase(s) in response: {offending}")

        return EvalResult(
            case_id=case.case_id,
            passed=not reasons,
            reasons=tuple(reasons),
            refusal=out.refusal,
            citation_count=len(out.citations),
            scores=score_case(case, out).to_dict(),
        )


def _to_retrieved(chunk: GoldenChunk) -> RetrievedChunk:
    return RetrievedChunk(
        chunk_id=chunk.chunk_id,
        doc_id=chunk.doc_id,
        version_id=chunk.version_id,
        page=chunk.page,
        char_start=0,
        char_end=len(chunk.content),
        score=chunk.score,
        content=chunk.content,
    )
