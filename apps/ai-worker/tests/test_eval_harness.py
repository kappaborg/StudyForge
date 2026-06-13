"""Eval harness — loader, structural evaluator, runner aggregation."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from src.eval import (
    EvalRunner,
    GoldenCase,
    StructuralEvaluator,
    Threshold,
    load_golden_set,
)
from src.eval.contracts import GoldenChunk

REPO_ROOT = Path(__file__).resolve().parents[3]
SHIPPED_GOLDEN = REPO_ROOT / "packages" / "eval-harness" / "golden" / "tutor.answer.v1" / "cases.jsonl"


# ── loader ────────────────────────────────────────────────────────────────────


def test_loader_reads_jsonl_skipping_comments(tmp_path: Path) -> None:
    p = tmp_path / "cases.jsonl"
    p.write_text(
        "# comment header\n"
        "\n"
        '{"case_id": "a", "query": "Q?", "expect_refusal": true}\n'
        "# inline comment\n"
        '{"case_id": "b", "query": "Q?", "chunks": [{"chunk_id": "c1", "content": "..."}], "expected_chunks": ["c1"]}\n'  # noqa: E501 — golden-case fixture is single-line by spec
    )
    cases = load_golden_set(p)
    assert [c.case_id for c in cases] == ["a", "b"]
    assert cases[0].expect_refusal is True
    assert cases[1].chunks[0].chunk_id == "c1"


def test_loader_rejects_duplicate_case_ids(tmp_path: Path) -> None:
    p = tmp_path / "dup.jsonl"
    p.write_text(
        '{"case_id": "x", "query": "Q?"}\n'
        '{"case_id": "x", "query": "Q?"}\n'
    )
    with pytest.raises(ValueError, match="duplicate case_id"):
        load_golden_set(p)


def test_loader_reports_line_number_on_bad_json(tmp_path: Path) -> None:
    p = tmp_path / "bad.jsonl"
    p.write_text('{"case_id": "ok", "query": "Q?"}\n{ not json\n')
    with pytest.raises(ValueError, match=":2:"):
        load_golden_set(p)


def test_loader_reports_missing_required_field(tmp_path: Path) -> None:
    p = tmp_path / "missing.jsonl"
    p.write_text('{"case_id": "x"}\n')
    with pytest.raises(ValueError, match="missing required field 'query'"):
        load_golden_set(p)


# ── structural evaluator ─────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_evaluator_passes_refusal_case() -> None:
    case = GoldenCase(case_id="r1", query="Q?", expect_refusal=True)
    r = await StructuralEvaluator().evaluate(case)
    assert r.passed
    assert r.reasons == ()
    assert r.refusal is True


@pytest.mark.asyncio
async def test_evaluator_fails_refusal_case_when_agent_actually_answers() -> None:
    # Supportive chunks + a citation-tagged scripted response → tutor returns
    # an answer with a citation → contradicts ``expect_refusal=True``.
    case = GoldenCase(
        case_id="r2",
        query="Q?",
        expect_refusal=True,
        chunks=(GoldenChunk(chunk_id="c1", content="Real content.", score=0.92),),
        model_response="Answer [chunk:c1].",
    )
    r = await StructuralEvaluator().evaluate(case)
    assert not r.passed
    reasons = " ".join(r.reasons)
    assert "expected refusal" in reasons or "must carry zero citations" in reasons


@pytest.mark.asyncio
async def test_evaluator_passes_cited_case_with_default_response() -> None:
    case = GoldenCase(
        case_id="c1",
        query="Q?",
        chunks=(GoldenChunk(chunk_id="c1", content="Content.", score=0.92),),
        expected_chunks=("c1",),
    )
    r = await StructuralEvaluator().evaluate(case)
    assert r.passed
    assert r.citation_count == 1


@pytest.mark.asyncio
async def test_evaluator_fails_when_expected_citation_missing() -> None:
    case = GoldenCase(
        case_id="c2",
        query="Q?",
        chunks=(GoldenChunk(chunk_id="c1", content="Content.", score=0.92),),
        expected_chunks=("c1", "c2"),  # c2 was never supplied
        model_response="Answer [chunk:c1].",
    )
    r = await StructuralEvaluator().evaluate(case)
    assert not r.passed
    assert any("missing expected citations" in reason for reason in r.reasons)


@pytest.mark.asyncio
async def test_evaluator_drops_hallucinated_citation_and_still_passes() -> None:
    # Mirrors the live tutor behaviour: fake chunk ids are dropped, real ones
    # survive. The eval treats this as a pass because the expected chunks are
    # present and no hard contract is broken.
    case = GoldenCase(
        case_id="halluc",
        query="Q?",
        chunks=(GoldenChunk(chunk_id="real-1", content="X", score=0.92),),
        expected_chunks=("real-1",),
        model_response="Answer [chunk:real-1]. Hallucination [chunk:fake-99].",
    )
    r = await StructuralEvaluator().evaluate(case)
    assert r.passed
    assert r.citation_count == 1


@pytest.mark.asyncio
async def test_evaluator_fails_on_banned_phrase() -> None:
    case = GoldenCase(
        case_id="banned",
        query="Q?",
        chunks=(GoldenChunk(chunk_id="c1", content="Content.", score=0.92),),
        expected_chunks=("c1",),
        must_not_contain=("overfitting",),
        model_response="Beware of overfitting [chunk:c1].",
    )
    r = await StructuralEvaluator().evaluate(case)
    assert not r.passed
    assert any("banned phrase" in reason for reason in r.reasons)


# ── runner aggregation ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_runner_aggregates_pass_fail_counts() -> None:
    cases = [
        GoldenCase(case_id="p", query="Q?", expect_refusal=True),
        GoldenCase(
            case_id="f",
            query="Q?",
            expect_refusal=True,
            chunks=(GoldenChunk(chunk_id="c1", content="Real.", score=0.92),),
            model_response="Answer [chunk:c1].",  # tutor cites → refusal contradicted
        ),
    ]
    report = await EvalRunner().run(prompt_id="tutor.answer.v1", cases=cases)
    assert report.total == 2
    assert report.passed == 1
    assert report.failed == 1
    assert report.pass_rate == 0.5
    assert report.meets_threshold is False  # default threshold = 1.0


@pytest.mark.asyncio
async def test_runner_meets_threshold_when_pass_rate_high_enough() -> None:
    cases = [GoldenCase(case_id="p", query="Q?", expect_refusal=True)]
    report = await EvalRunner().run(
        prompt_id="tutor.answer.v1",
        cases=cases,
        threshold=Threshold(prompt_id="tutor.answer.v1", min_pass_rate=0.95),
    )
    assert report.meets_threshold is True


# ── shipped golden set ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_shipped_golden_set_passes_at_full_threshold() -> None:
    """The seed golden set must always pass at 100% — it's the floor."""
    assert SHIPPED_GOLDEN.exists()
    report = await EvalRunner().run_path(
        prompt_id="tutor.answer.v1",
        golden_path=SHIPPED_GOLDEN,
    )
    assert report.meets_threshold, json.dumps(report.to_jsonable(), indent=2)
    assert report.passed == report.total


# ── LLM-judge / Ragas mode ──────────────────────────────────────────────────

from collections.abc import AsyncIterator

from src.agents.contracts import TutorOutput
from src.eval.llm_judge import LlmJudge, _clamp, _extract_json_object
from src.eval.ragas import RagasEvaluator
from src.llm.contracts import (
    LLMProvider,
    LLMRequest,
    LLMResponse,
    LLMStreamChunk,
    LLMUsage,
)


class _FakeJudgeProvider(LLMProvider):
    """Returns a fixed text payload so judge logic can be tested without
    a real LLM call."""

    id: str = "fake-judge"
    supports_prompt_cache: bool = False
    supports_streaming: bool = False
    context_window_tokens: int = 8000

    def __init__(self, text: str) -> None:
        self._text = text
        self.calls: list[LLMRequest] = []

    async def complete(self, req: LLMRequest) -> LLMResponse:
        self.calls.append(req)
        return LLMResponse(
            text=self._text,
            finish_reason="stop",
            usage=LLMUsage(tokens_in=0, tokens_out=0, cached_tokens_in=0, cache_hit=False),
            model=req.model,
            provider_id="fake-judge",
        )

    def stream(self, req: LLMRequest) -> AsyncIterator[LLMStreamChunk]:  # pragma: no cover
        raise NotImplementedError

    async def ping(self) -> dict[str, object]:  # pragma: no cover
        return {"ok": True}


def test_clamp_handles_out_of_range_and_garbage() -> None:
    assert _clamp(0.5) == 0.5
    assert _clamp(1.5) == 1.0
    assert _clamp(-0.5) == 0.0
    assert _clamp("not a number") == 0.0
    assert _clamp(None) == 0.0


def test_extract_json_object_bare() -> None:
    assert _extract_json_object('{"a": 1}') == {"a": 1}


def test_extract_json_object_with_fence() -> None:
    text = 'Sure, here:\n```json\n{"a": 1, "b": 2}\n```\n'
    assert _extract_json_object(text) == {"a": 1, "b": 2}


def test_extract_json_object_with_preamble() -> None:
    text = 'I think: {"a": 1}'
    assert _extract_json_object(text) == {"a": 1}


def test_extract_json_object_raises_on_no_json() -> None:
    with pytest.raises(ValueError):
        _extract_json_object("the answer is excellent")


@pytest.mark.asyncio
async def test_llm_judge_parses_well_formed_response() -> None:
    provider = _FakeJudgeProvider(
        '{"faithfulness": 0.9, "answer_relevance": 0.85, "context_recall": 0.7, '
        '"reasoning": "answer covers the question well"}'
    )
    judge = LlmJudge(provider=provider, model="judge-test")
    case = GoldenCase(
        case_id="c1",
        query="What does photosynthesis produce?",
        chunks=(GoldenChunk(chunk_id="ch1", content="Photosynthesis produces glucose."),),
        expected_chunks=("ch1",),
    )
    out = TutorOutput(
        session_id="00000000-0000-0000-0000-000000000000",
        text="It produces glucose.",
        citations=[],
        refusal=False,
    )
    scores = await judge.score(case, out)
    assert scores.faithfulness == 0.9
    assert scores.answer_relevance == 0.85
    assert scores.context_recall == 0.7
    assert "covers" in scores.reasoning


@pytest.mark.asyncio
async def test_llm_judge_returns_zeros_on_garbage_response() -> None:
    provider = _FakeJudgeProvider("the answer is honestly pretty good imo")
    judge = LlmJudge(provider=provider, model="judge-test")
    case = GoldenCase(case_id="c1", query="Q?", chunks=(), expect_refusal=True)
    out = TutorOutput(
        session_id="00000000-0000-0000-0000-000000000000",
        text="",
        citations=[],
        refusal=True,
    )
    scores = await judge.score(case, out)
    assert scores.faithfulness == 0.0
    assert scores.answer_relevance == 0.0
    assert scores.context_recall == 0.0
    assert "did not parse" in scores.reasoning


@pytest.mark.asyncio
async def test_ragas_evaluator_merges_structural_and_judge_scores() -> None:
    provider = _FakeJudgeProvider(
        '{"faithfulness": 1.0, "answer_relevance": 1.0, "context_recall": 1.0, "reasoning": "ok"}'
    )
    judge = LlmJudge(provider=provider, model="judge-test")
    case = GoldenCase(
        case_id="c1",
        query="What does photosynthesis produce?",
        chunks=(GoldenChunk(chunk_id="ch1", content="Photosynthesis produces glucose and oxygen."),),
        expected_chunks=("ch1",),
    )
    evaluator = RagasEvaluator(judge=judge)
    result = await evaluator.evaluate(case)
    # Structural lite scores still present.
    assert "citation_validity" in result.scores
    assert "context_precision" in result.scores
    # Judge scores layered on top.
    assert result.scores["faithfulness"] == 1.0
    assert result.scores["answer_relevance"] == 1.0
    assert result.scores["context_recall"] == 1.0
    # Structural pass/fail is preserved.
    assert result.passed is True
    # The judge was actually called.
    assert len(provider.calls) == 1
    assert provider.calls[0].temperature == 0.0
