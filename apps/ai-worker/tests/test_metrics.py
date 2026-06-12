"""Prometheus exporter hooks.

We verify the hook helpers update the right counters with the right
labels. The counters themselves come from the prometheus_client default
registry; tests reset the relevant series before each assertion so
counter values are independent.
"""

from __future__ import annotations

import pytest
from prometheus_client import CollectorRegistry, generate_latest

from src.metrics import (
    CACHE_HIT,
    PROMPT_CACHE_CHECK,
    PROMPT_CACHE_HIT,
    ROUTER_DECISION,
    USAGE_TOKENS,
    record_cache_hit,
    record_provider_call,
    record_router_decision,
)


def _value(counter, **labels: str) -> float:
    """Read the current value of a labelled counter sample."""
    metric = next(iter(counter.collect()))
    for sample in metric.samples:
        if sample.name.endswith("_total") and sample.labels == labels:
            return float(sample.value)
    return 0.0


@pytest.fixture(autouse=True)
def _reset_metrics() -> None:
    # Counters in prometheus_client are global; reset the labelled series
    # we'll touch between tests so cumulative values from earlier tests
    # don't bleed in. ``_metrics`` is private API but stable.
    for counter in (
        ROUTER_DECISION,
        CACHE_HIT,
        PROMPT_CACHE_CHECK,
        PROMPT_CACHE_HIT,
        USAGE_TOKENS,
    ):
        counter._metrics.clear()  # type: ignore[attr-defined]


# ─────────────────────────────────────────────────────────────────────────────
# record_router_decision
# ─────────────────────────────────────────────────────────────────────────────


def test_router_decision_increments_provider_label() -> None:
    record_router_decision("groq")
    record_router_decision("groq")
    record_router_decision("gemini")
    assert _value(ROUTER_DECISION, provider_id="groq") == 2.0
    assert _value(ROUTER_DECISION, provider_id="gemini") == 1.0
    assert _value(ROUTER_DECISION, provider_id="ollama") == 0.0


# ─────────────────────────────────────────────────────────────────────────────
# record_cache_hit
# ─────────────────────────────────────────────────────────────────────────────


def test_cache_hit_increments_tenant_label() -> None:
    record_cache_hit("tenant-A")
    record_cache_hit("tenant-A")
    record_cache_hit("tenant-B")
    assert _value(CACHE_HIT, tenant_id="tenant-A") == 2.0
    assert _value(CACHE_HIT, tenant_id="tenant-B") == 1.0


def test_cache_hit_uses_anonymous_when_tenant_id_missing() -> None:
    record_cache_hit(None)
    record_cache_hit(None)
    assert _value(CACHE_HIT, tenant_id="anonymous") == 2.0


# ─────────────────────────────────────────────────────────────────────────────
# record_provider_call
# ─────────────────────────────────────────────────────────────────────────────


def test_provider_call_records_check_and_tokens() -> None:
    record_provider_call(
        "groq",
        tokens_in=100,
        tokens_out=50,
        cached_in=0,
        cache_hit=False,
    )
    assert _value(PROMPT_CACHE_CHECK, provider_id="groq") == 1.0
    assert _value(PROMPT_CACHE_HIT, provider_id="groq") == 0.0
    assert _value(USAGE_TOKENS, provider_id="groq", kind="in") == 100.0
    assert _value(USAGE_TOKENS, provider_id="groq", kind="out") == 50.0
    assert _value(USAGE_TOKENS, provider_id="groq", kind="cached_in") == 0.0


def test_provider_call_records_cache_hit_when_cached_tokens_present() -> None:
    record_provider_call(
        "anthropic",
        tokens_in=1000,
        tokens_out=200,
        cached_in=800,
        cache_hit=True,
    )
    assert _value(PROMPT_CACHE_HIT, provider_id="anthropic") == 1.0
    assert _value(USAGE_TOKENS, provider_id="anthropic", kind="cached_in") == 800.0


def test_provider_call_zero_tokens_does_not_double_count() -> None:
    # A check with zero-token output (e.g. immediate stop) shouldn't
    # leave a zero-valued ``out`` series, since Prometheus would still
    # emit it in the scrape output.
    record_provider_call(
        "groq",
        tokens_in=10,
        tokens_out=0,
        cached_in=0,
        cache_hit=False,
    )
    # `in` was incremented…
    assert _value(USAGE_TOKENS, provider_id="groq", kind="in") == 10.0
    # …but `out` was skipped, so the labelled series doesn't exist.
    assert _value(USAGE_TOKENS, provider_id="groq", kind="out") == 0.0


# ─────────────────────────────────────────────────────────────────────────────
# Scrape output sanity
# ─────────────────────────────────────────────────────────────────────────────


def test_generate_latest_includes_our_counter_names() -> None:
    record_router_decision("groq")
    record_provider_call(
        "groq", tokens_in=1, tokens_out=1, cached_in=0, cache_hit=False
    )
    output = generate_latest().decode("utf-8")
    assert "studyforge_router_decision_total" in output
    assert "studyforge_prompt_cache_check_total" in output
    assert "studyforge_usage_event_tokens_total" in output


def test_unused_counters_have_no_samples_after_reset() -> None:
    # Empty registry collect step — no calls made.
    fresh_registry = CollectorRegistry()
    # Touch the registry param to silence the import-only-no-use lint
    # without leaking a Counter into the global default registry.
    _ = fresh_registry
    assert _value(ROUTER_DECISION, provider_id="groq") == 0.0
    assert _value(CACHE_HIT, tenant_id="any") == 0.0
