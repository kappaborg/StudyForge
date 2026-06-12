"""Prometheus counters for the §13 cost story.

The metric names + label sets here match what the Grafana dashboard at
``infra/grafana/dashboards/platform-cost.json`` expects. If you change a
name or a label here, update the dashboard queries in the same commit.

What we count today
  ``studyforge_router_decision_total{provider_id}``
      One increment per provider pick in the §13.1 free-tier ladder.
      Drives the "% queries served free" stat.

  ``studyforge_cache_hit_total{tenant_id}``
      One increment per semantic-cache hit on the tutor path. Drives the
      cache-effectiveness panel and is the Phase-1 exit signal for the
      "≥ 40% cache hit rate" criterion.

  ``studyforge_prompt_cache_check_total{provider_id}``
      One increment per provider call that *could* have been a cache hit
      (i.e. every successful ``complete()`` / final stream chunk that
      reports ``LLMUsage``). Denominator for prompt cache hit ratio.

  ``studyforge_prompt_cache_hit_total{provider_id}``
      Increments when ``LLMUsage.cache_hit`` is True on the same return.
      Drives the "Prompt cache hit rate" stat.

  ``studyforge_usage_event_tokens_total{provider_id, kind}``
      Token throughput by direction (``in`` / ``out`` / ``cached_in``).
      Drives the token-throughput timeseries.

What we DON'T count yet
  ``studyforge_usage_event_cost_micro_usd`` — needs a per-provider price
  table that lives in the ``cost-ledger`` TS package today. Phase B-5b
  will mirror it server-side or move the conversion into the worker.

The collector default registry is used so the FastAPI ``/metrics`` route
can call ``generate_latest()`` without extra wiring.
"""

from __future__ import annotations

from prometheus_client import Counter

# ─────────────────────────────────────────────────────────────────────────────
# Definitions
# ─────────────────────────────────────────────────────────────────────────────

ROUTER_DECISION = Counter(
    "studyforge_router_decision_total",
    "Provider picked by the §13.1 router for an outbound call.",
    labelnames=("provider_id",),
)

CACHE_HIT = Counter(
    "studyforge_cache_hit_total",
    "Semantic-cache hit on the tutor path (cosine ≥ threshold over the bge-small embedding).",
    labelnames=("tenant_id",),
)

PROMPT_CACHE_CHECK = Counter(
    "studyforge_prompt_cache_check_total",
    "Provider call returned with usage info (cache hit eligible).",
    labelnames=("provider_id",),
)

PROMPT_CACHE_HIT = Counter(
    "studyforge_prompt_cache_hit_total",
    "Provider reported cached input tokens > 0 (LLMUsage.cache_hit).",
    labelnames=("provider_id",),
)

USAGE_TOKENS = Counter(
    "studyforge_usage_event_tokens_total",
    "Tokens billed on a provider call, separated by direction.",
    labelnames=("provider_id", "kind"),
)


# ─────────────────────────────────────────────────────────────────────────────
# Hooks — single-line helpers callers use; do not instantiate Counter labels
# at call sites because typos silently create new metric series.
# ─────────────────────────────────────────────────────────────────────────────


def record_router_decision(provider_id: str) -> None:
    ROUTER_DECISION.labels(provider_id=provider_id).inc()


def record_cache_hit(tenant_id: str | None) -> None:
    # Use the literal string "anonymous" rather than None — Prometheus
    # rejects label values that don't exist as strings. Cache hits are
    # rare enough that the anonymous bucket isn't a cardinality risk.
    CACHE_HIT.labels(tenant_id=tenant_id or "anonymous").inc()


def record_provider_call(
    provider_id: str,
    *,
    tokens_in: int,
    tokens_out: int,
    cached_in: int,
    cache_hit: bool,
) -> None:
    """Single hook called after every successful ``complete()`` /
    final stream chunk. Increments four counters at once so caller
    instrumentation stays one line."""
    PROMPT_CACHE_CHECK.labels(provider_id=provider_id).inc()
    if cache_hit:
        PROMPT_CACHE_HIT.labels(provider_id=provider_id).inc()
    if tokens_in:
        USAGE_TOKENS.labels(provider_id=provider_id, kind="in").inc(tokens_in)
    if tokens_out:
        USAGE_TOKENS.labels(provider_id=provider_id, kind="out").inc(tokens_out)
    if cached_in:
        USAGE_TOKENS.labels(provider_id=provider_id, kind="cached_in").inc(cached_in)


__all__ = [
    "CACHE_HIT",
    "PROMPT_CACHE_CHECK",
    "PROMPT_CACHE_HIT",
    "ROUTER_DECISION",
    "USAGE_TOKENS",
    "record_cache_hit",
    "record_provider_call",
    "record_router_decision",
]
