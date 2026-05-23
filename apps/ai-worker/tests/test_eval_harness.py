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
        '{"case_id": "b", "query": "Q?", "chunks": [{"chunk_id": "c1", "content": "..."}], "expected_chunks": ["c1"]}\n'
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
