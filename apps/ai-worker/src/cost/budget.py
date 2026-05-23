"""Budget evaluator.

Decides whether an LLM call may proceed and at what model. The LLM router
calls ``BudgetEvaluator.evaluate`` before every provider call; the returned
decision dictates the routing branch.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum

from .tier_policy import ExhaustPolicy, TierConfig, TierName, TierPolicy


class DecisionKind(StrEnum):
    allow = "allow"
    warn = "warn"
    downshift = "downshift"
    rate_limit = "rate_limit"
    block = "block"


@dataclass(frozen=True)
class UsageSnapshot:
    """Aggregate token usage for the current daily and monthly windows."""

    daily_used: int
    monthly_used: int


@dataclass(frozen=True)
class BudgetDecision:
    kind: DecisionKind
    """The action the router must take."""

    reason: str
    """Human-readable explanation, surfaced in OTel attributes and the
    in-app notification body."""

    suggested_providers: tuple[str, ...]
    """Provider order the router should use for this call."""

    daily_remaining: int
    """Tokens remaining today (-1 for unlimited)."""

    monthly_remaining: int


class BudgetEvaluator:
    """Stateless given a policy snapshot. The router constructs one at boot and
    passes a fresh ``UsageSnapshot`` per call (loaded from the cost ledger)."""

    def __init__(self, policy: TierPolicy) -> None:
        self._policy = policy

    def evaluate(
        self,
        *,
        tier: TierName,
        estimated_input_tokens: int,
        usage: UsageSnapshot,
    ) -> BudgetDecision:
        if estimated_input_tokens < 0:
            raise ValueError("estimated_input_tokens must be non-negative")

        config = self._policy.tiers.get(tier)
        if config is None:
            return BudgetDecision(
                kind=DecisionKind.block,
                reason=f"tier '{tier.value}' is not configured in policy",
                suggested_providers=(),
                daily_remaining=0,
                monthly_remaining=0,
            )

        daily_remaining = _remaining(config.daily_tokens, usage.daily_used)
        monthly_remaining = _remaining(config.monthly_tokens, usage.monthly_used)

        # Monthly cap is the harder limit. Check it first.
        if monthly_remaining != _UNLIMITED and monthly_remaining < estimated_input_tokens:
            return self._on_exhaust(
                config,
                reason="monthly token cap reached",
                daily_remaining=daily_remaining,
                monthly_remaining=monthly_remaining,
            )

        if daily_remaining != _UNLIMITED and daily_remaining < estimated_input_tokens:
            return self._on_exhaust(
                config,
                reason="daily token cap reached",
                daily_remaining=daily_remaining,
                monthly_remaining=monthly_remaining,
            )

        # Soft warn between 80% and 100% of the daily window.
        if (
            daily_remaining != _UNLIMITED
            and config.daily_tokens > 0
            and usage.daily_used >= _warn_threshold(config.daily_tokens, self._policy.warn_threshold_pct)
        ):
            return BudgetDecision(
                kind=DecisionKind.warn,
                reason=f"daily usage above {self._policy.warn_threshold_pct}%; budget will downshift soon",
                suggested_providers=tuple(config.providers),
                daily_remaining=daily_remaining,
                monthly_remaining=monthly_remaining,
            )

        return BudgetDecision(
            kind=DecisionKind.allow,
            reason="within budget",
            suggested_providers=tuple(config.providers),
            daily_remaining=daily_remaining,
            monthly_remaining=monthly_remaining,
        )

    def _on_exhaust(
        self,
        config: TierConfig,
        *,
        reason: str,
        daily_remaining: int,
        monthly_remaining: int,
    ) -> BudgetDecision:
        kind_map = {
            ExhaustPolicy.downshift: DecisionKind.downshift,
            ExhaustPolicy.rate_limit: DecisionKind.rate_limit,
            ExhaustPolicy.block: DecisionKind.block,
        }
        kind = kind_map[config.on_exhaust]

        # On downshift the suggested providers stay the same list — they are
        # already the cheapest. The router picks the first free-tier provider
        # with available quota at call time.
        return BudgetDecision(
            kind=kind,
            reason=reason,
            suggested_providers=tuple(config.providers),
            daily_remaining=daily_remaining,
            monthly_remaining=monthly_remaining,
        )


_UNLIMITED = -1


def _remaining(cap: int, used: int) -> int:
    if cap == _UNLIMITED:
        return _UNLIMITED
    return max(0, cap - used)


def _warn_threshold(cap: int, pct: int) -> int:
    return (cap * pct) // 100
