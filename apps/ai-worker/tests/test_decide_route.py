"""Cost-aware route decision — precedence: BYOK > credits > free > paid."""

from __future__ import annotations

from src.cost.budget import BudgetDecision, DecisionKind
from src.cost.complexity import ComplexityClass
from src.cost.decide import (
    CreditBalance,
    ProviderHealth,
    decide_route,
)


def _healthy(provider_id: str, tokens: int = 100_000) -> ProviderHealth:
    return ProviderHealth(
        provider_id=provider_id,
        tokens_remaining=tokens,
        healthy=True,
        avg_latency_ms=200,
    )


def _allow_budget(providers: tuple[str, ...] = ("groq", "gemini_free")) -> BudgetDecision:
    return BudgetDecision(
        kind=DecisionKind.allow,
        reason="within budget",
        suggested_providers=providers,
        daily_remaining=200_000,
        monthly_remaining=3_000_000,
    )


def test_byok_always_wins() -> None:
    budget = _allow_budget()
    providers = {
        "groq": _healthy("groq"),
        "anthropic": _healthy("anthropic"),
    }
    out = decide_route(
        complexity=ComplexityClass.complex,
        budget=budget,
        providers=providers,
        byok_provider="anthropic",
    )
    assert out.status == "allow"
    assert out.candidates[0].provider_id == "user_byok"
    assert out.candidates[0].reason.startswith("BYOK present")


def test_credit_balance_preferred_over_free_tier() -> None:
    budget = _allow_budget()
    providers = {
        "groq": _healthy("groq"),
        "anthropic": _healthy("anthropic"),
    }
    out = decide_route(
        complexity=ComplexityClass.medium,
        budget=budget,
        providers=providers,
        credits=[
            CreditBalance(
                provider_id="anthropic",
                tokens_remaining=1_000_000,
                program_name="anthropic_for_education",
            )
        ],
    )
    assert out.candidates[0].provider_id == "anthropic"
    assert "credit" in out.candidates[0].reason


def test_free_first_on_simple_query() -> None:
    budget = _allow_budget(("groq", "gemini_free", "openrouter_free"))
    providers = {
        "groq": _healthy("groq"),
        "gemini_free": _healthy("gemini_free"),
        "anthropic": _healthy("anthropic"),
    }
    out = decide_route(
        complexity=ComplexityClass.simple,
        budget=budget,
        providers=providers,
    )
    # First candidate must be a free provider in the preferred order.
    assert out.candidates[0].provider_id in {"groq", "gemini_free"}
    # Anthropic must not appear in the candidate list at all under allow.
    assert all(c.provider_id != "anthropic" for c in out.candidates)


def test_downshift_falls_back_to_paid_when_free_exhausted() -> None:
    budget = BudgetDecision(
        kind=DecisionKind.downshift,
        reason="daily token cap reached",
        suggested_providers=("groq", "gemini_free"),
        daily_remaining=0,
        monthly_remaining=1_000_000,
    )
    # All free providers exhausted.
    providers = {
        "groq": ProviderHealth("groq", 0, True, 100),
        "gemini_free": ProviderHealth("gemini_free", 0, True, 100),
        "anthropic": _healthy("anthropic"),
    }
    out = decide_route(
        complexity=ComplexityClass.complex,
        budget=budget,
        providers=providers,
    )
    assert out.status == "allow"
    # First candidate is a paid provider on downshift exhaustion.
    assert out.candidates[0].provider_id in {"anthropic", "openai"}


def test_rate_limit_returns_typed_status_for_paid_tier() -> None:
    budget = BudgetDecision(
        kind=DecisionKind.rate_limit,
        reason="daily token cap reached",
        suggested_providers=(),
        daily_remaining=0,
        monthly_remaining=0,
    )
    providers: dict[str, ProviderHealth] = {}
    out = decide_route(
        complexity=ComplexityClass.medium,
        budget=budget,
        providers=providers,
    )
    assert out.status == "rate_limited"


def test_block_returns_typed_status() -> None:
    budget = BudgetDecision(
        kind=DecisionKind.block,
        reason="monthly token cap reached",
        suggested_providers=(),
        daily_remaining=0,
        monthly_remaining=0,
    )
    out = decide_route(
        complexity=ComplexityClass.simple,
        budget=budget,
        providers={},
    )
    assert out.status == "blocked"


def test_unhealthy_provider_skipped() -> None:
    budget = _allow_budget(("groq", "gemini_free"))
    providers = {
        "groq": ProviderHealth("groq", 100_000, False, 100),  # unhealthy
        "gemini_free": _healthy("gemini_free"),
    }
    out = decide_route(
        complexity=ComplexityClass.simple,
        budget=budget,
        providers=providers,
    )
    assert all(c.provider_id != "groq" for c in out.candidates)
    assert any(c.provider_id == "gemini_free" for c in out.candidates)


def test_zero_remaining_quota_skipped() -> None:
    budget = _allow_budget(("groq", "gemini_free"))
    providers = {
        "groq": ProviderHealth("groq", 0, True, 100),
        "gemini_free": _healthy("gemini_free"),
    }
    out = decide_route(
        complexity=ComplexityClass.simple,
        budget=budget,
        providers=providers,
    )
    assert out.candidates[0].provider_id == "gemini_free"


def test_credit_balance_with_zero_tokens_ignored() -> None:
    budget = _allow_budget(("groq", "gemini_free"))
    out = decide_route(
        complexity=ComplexityClass.medium,
        budget=budget,
        providers={"anthropic": _healthy("anthropic"), "groq": _healthy("groq")},
        credits=[
            CreditBalance(
                provider_id="anthropic",
                tokens_remaining=0,
                program_name="anthropic_for_education",
            )
        ],
    )
    # Exhausted credits drop out — the free path takes over.
    assert all(c.provider_id != "anthropic" for c in out.candidates)
