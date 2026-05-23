"""Budget evaluator — allow / warn / downshift / rate_limit / block."""

from __future__ import annotations

from pathlib import Path

import pytest

from src.cost import (
    BudgetDecision,
    BudgetEvaluator,
    DecisionKind,
    TierPolicy,
    UsageSnapshot,
    load_tier_policy,
)
from src.cost.tier_policy import (
    BillingParty,
    ExhaustPolicy,
    TierConfig,
    TierName,
)


REPO_ROOT = Path(__file__).resolve().parents[3]
POLICY_PATH = REPO_ROOT / "infra" / "tiers" / "policy.yaml"


def _policy(**override_free: object) -> TierPolicy:
    return TierPolicy.model_validate(
        {
            "tiers": {
                "free": {
                    "daily_tokens": 100,
                    "monthly_tokens": 1000,
                    "providers": ["groq", "gemini_free"],
                    "on_exhaust": "downshift",
                    "billing": "platform",
                    **override_free,
                },
                "pro": {
                    "daily_tokens": 10_000,
                    "monthly_tokens": -1,
                    "providers": ["anthropic", "openai"],
                    "on_exhaust": "rate_limit",
                    "billing": "user",
                },
            },
            "warn_threshold_pct": 80,
        }
    )


def test_committed_policy_loads_and_validates() -> None:
    policy = load_tier_policy(POLICY_PATH)
    assert policy.tiers[TierName.free].on_exhaust is ExhaustPolicy.downshift
    assert policy.tiers[TierName.byok].billing is BillingParty.user
    assert policy.tiers[TierName.institutional].billing is BillingParty.institution


def test_policy_rejects_block_on_free_tier() -> None:
    with pytest.raises(ValueError, match="contradicts Operating Principle"):
        TierPolicy.model_validate(
            {
                "tiers": {
                    "free": {
                        "daily_tokens": 100,
                        "monthly_tokens": 1000,
                        "providers": ["groq"],
                        "on_exhaust": "block",
                        "billing": "platform",
                    }
                }
            }
        )


def test_evaluator_allows_within_budget() -> None:
    evaluator = BudgetEvaluator(_policy())
    out = evaluator.evaluate(
        tier=TierName.free,
        estimated_input_tokens=10,
        usage=UsageSnapshot(daily_used=10, monthly_used=10),
    )
    assert out.kind is DecisionKind.allow
    assert out.daily_remaining == 90


def test_evaluator_warns_above_80pct_daily() -> None:
    evaluator = BudgetEvaluator(_policy())
    out = evaluator.evaluate(
        tier=TierName.free,
        estimated_input_tokens=1,
        usage=UsageSnapshot(daily_used=85, monthly_used=100),
    )
    assert out.kind is DecisionKind.warn


def test_free_tier_exhaustion_downshifts_never_blocks() -> None:
    evaluator = BudgetEvaluator(_policy())
    out = evaluator.evaluate(
        tier=TierName.free,
        estimated_input_tokens=50,
        usage=UsageSnapshot(daily_used=80, monthly_used=200),
    )
    assert out.kind is DecisionKind.downshift
    # Suggested providers stay the free list — router picks first with quota.
    assert out.suggested_providers == ("groq", "gemini_free")


def test_paid_tier_rate_limits_on_daily_exhaustion() -> None:
    evaluator = BudgetEvaluator(_policy())
    out = evaluator.evaluate(
        tier=TierName.pro,
        estimated_input_tokens=10,
        usage=UsageSnapshot(daily_used=10_000, monthly_used=20_000),
    )
    assert out.kind is DecisionKind.rate_limit


def test_unknown_tier_returns_block_with_reason() -> None:
    evaluator = BudgetEvaluator(_policy())
    # Use a fresh policy that omits byok.
    out = evaluator.evaluate(
        tier=TierName.byok,
        estimated_input_tokens=10,
        usage=UsageSnapshot(daily_used=0, monthly_used=0),
    )
    assert out.kind is DecisionKind.block
    assert "not configured" in out.reason


def test_evaluator_rejects_negative_token_estimates() -> None:
    evaluator = BudgetEvaluator(_policy())
    with pytest.raises(ValueError):
        evaluator.evaluate(
            tier=TierName.free,
            estimated_input_tokens=-1,
            usage=UsageSnapshot(daily_used=0, monthly_used=0),
        )


def test_unlimited_cap_never_exhausts() -> None:
    policy = TierPolicy.model_validate(
        {
            "tiers": {
                "byok": {
                    "daily_tokens": -1,
                    "monthly_tokens": -1,
                    "providers": ["user_byok"],
                    "on_exhaust": "rate_limit",
                    "billing": "user",
                }
            }
        }
    )
    evaluator = BudgetEvaluator(policy)
    out = evaluator.evaluate(
        tier=TierName.byok,
        estimated_input_tokens=10**9,
        usage=UsageSnapshot(daily_used=10**9, monthly_used=10**12),
    )
    assert out.kind is DecisionKind.allow
    assert out.daily_remaining == -1
    assert out.monthly_remaining == -1


# Asserting the BudgetDecision type is importable from the package root.
def test_budget_decision_is_publicly_exported() -> None:
    decision = BudgetDecision(
        kind=DecisionKind.allow,
        reason="x",
        suggested_providers=("a",),
        daily_remaining=10,
        monthly_remaining=100,
    )
    # frozen → mutation raises
    with pytest.raises(Exception):
        decision.kind = DecisionKind.block  # type: ignore[misc]


def test_unused_tier_config_import_is_referenced() -> None:
    # Ensures `TierConfig` stays in the public surface; mypy would catch the
    # symbol disappearing, but this lockstep avoids re-export drift.
    cfg = TierConfig(
        daily_tokens=1,
        monthly_tokens=2,
        providers=["x"],
        on_exhaust=ExhaustPolicy.downshift,
        billing=BillingParty.platform,
    )
    assert cfg.daily_tokens == 1
