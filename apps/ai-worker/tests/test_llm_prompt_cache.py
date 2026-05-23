"""Prompt caching — usage parsing across providers + cache_hit_ratio."""

from __future__ import annotations

from src.llm.anthropic import _extract_anthropic_usage
from src.llm.contracts import LLMUsage
from src.llm.openai_compat import extract_usage, maybe_usage


# ── LLMUsage cache_hit_ratio property ────────────────────────────────────────


def test_cache_hit_ratio_is_zero_when_no_input_tokens() -> None:
    assert LLMUsage(tokens_in=0, tokens_out=10).cache_hit_ratio == 0.0


def test_cache_hit_ratio_is_zero_when_no_cache_reported() -> None:
    assert LLMUsage(tokens_in=100, tokens_out=10).cache_hit_ratio == 0.0


def test_cache_hit_ratio_is_fraction_of_input_tokens_cached() -> None:
    u = LLMUsage(tokens_in=100, tokens_out=10, cached_tokens_in=75, cache_hit=True)
    assert u.cache_hit_ratio == 0.75


def test_cache_hit_ratio_clamps_to_one() -> None:
    # Pathological: provider says cached > input. Clamp to 1.0.
    u = LLMUsage(tokens_in=10, tokens_out=2, cached_tokens_in=20, cache_hit=True)
    assert u.cache_hit_ratio == 1.0


# ── OpenAI compat usage parsing ──────────────────────────────────────────────


def test_openai_extract_usage_without_cache_details_reports_no_hit() -> None:
    body = {"usage": {"prompt_tokens": 50, "completion_tokens": 5}}
    usage = extract_usage(body)
    assert usage.tokens_in == 50
    assert usage.tokens_out == 5
    assert usage.cached_tokens_in == 0
    assert usage.cache_hit is False


def test_openai_extract_usage_reads_cached_tokens_from_details() -> None:
    body = {
        "usage": {
            "prompt_tokens": 200,
            "completion_tokens": 12,
            "prompt_tokens_details": {"cached_tokens": 180},
        }
    }
    usage = extract_usage(body)
    assert usage.tokens_in == 200
    assert usage.cached_tokens_in == 180
    assert usage.cache_hit is True
    assert usage.cache_hit_ratio == 0.9


def test_openai_extract_usage_handles_zero_cached_tokens() -> None:
    body = {
        "usage": {
            "prompt_tokens": 50,
            "completion_tokens": 5,
            "prompt_tokens_details": {"cached_tokens": 0},
        }
    }
    usage = extract_usage(body)
    assert usage.cache_hit is False


def test_openai_maybe_usage_terminal_chunk_carries_cache_stats() -> None:
    obj = {
        "usage": {
            "prompt_tokens": 100,
            "completion_tokens": 8,
            "prompt_tokens_details": {"cached_tokens": 90},
        }
    }
    out = maybe_usage(obj)
    assert out is not None
    assert out.cached_tokens_in == 90
    assert out.cache_hit is True


# ── Anthropic usage parsing ──────────────────────────────────────────────────


def test_anthropic_usage_no_cache_when_field_absent() -> None:
    body = {"usage": {"input_tokens": 100, "output_tokens": 20}}
    usage = _extract_anthropic_usage(body)
    assert usage.tokens_in == 100
    assert usage.tokens_out == 20
    assert usage.cached_tokens_in == 0
    assert usage.cache_hit is False


def test_anthropic_usage_records_cache_read_tokens() -> None:
    body = {
        "usage": {
            "input_tokens": 200,
            "output_tokens": 15,
            "cache_read_input_tokens": 180,
        }
    }
    usage = _extract_anthropic_usage(body)
    assert usage.tokens_in == 200
    assert usage.cached_tokens_in == 180
    assert usage.cache_hit is True
    assert usage.cache_hit_ratio == 0.9
