"""Cost guardrails — tier policy + budget + complexity classifier + router decision.

The single funnel between an agent's intent to call a provider and the actual
call. Reads the YAML committed at `infra/tiers/policy.yaml`, classifies the
query, evaluates the budget, and selects an ordered provider chain.
"""

from .budget import (
    BudgetDecision as BudgetDecision,
    BudgetEvaluator as BudgetEvaluator,
    DecisionKind as DecisionKind,
    UsageSnapshot as UsageSnapshot,
)
from .complexity import (
    ComplexityClass as ComplexityClass,
    ComplexityFinding as ComplexityFinding,
    classify_query as classify_query,
)
from .decide import (
    CreditBalance as CreditBalance,
    ProviderHealth as ProviderHealth,
    RouteCandidate as RouteCandidate,
    RouteResult as RouteResult,
    decide_route as decide_route,
)
from .tier_policy import (
    TierConfig as TierConfig,
    TierPolicy as TierPolicy,
    load_tier_policy as load_tier_policy,
)
