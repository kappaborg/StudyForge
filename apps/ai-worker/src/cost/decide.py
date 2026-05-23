"""Cost-aware route decision.

Single function that the LLM router calls before every provider call. Returns
an ordered candidate list — the router tries them in order, advancing on
provider failure (handled by circuit breaker, not here).

Precedence (matches §13 design):

  1. BYOK present → user's key.
  2. Credit balance available for tier → credit-funded provider.
  3. Free tier provider with healthy quota for the complexity class.
  4. Budget says `downshift` on exhaustion → cheapest paid provider.
  5. Budget says `rate_limit` → typed `RateLimited` result; never reached for free.
  6. Budget says `block` (only legal for paid tiers) → typed `Blocked`.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from .budget import BudgetDecision, DecisionKind
from .complexity import ComplexityClass


@dataclass(frozen=True)
class ProviderHealth:
    """Sliding-window snapshot of a provider's reachability + remaining quota."""

    provider_id: str
    tokens_remaining: int     # -1 for unlimited
    healthy: bool
    avg_latency_ms: int


@dataclass(frozen=True)
class CreditBalance:
    """Educational / institutional credit on a specific provider."""

    provider_id: str
    tokens_remaining: int     # -1 for unlimited within the program
    program_name: str         # e.g. "anthropic_for_education"


@dataclass(frozen=True)
class RouteCandidate:
    provider_id: str
    model: str
    reason: str
    cacheable: bool
    """`true` when this provider supports prompt caching for the call shape."""


@dataclass(frozen=True)
class RouteResult:
    """The router's verdict. ``status`` discriminates outcomes that the caller
    must handle explicitly."""

    status: Literal["allow", "rate_limited", "blocked"]
    candidates: tuple[RouteCandidate, ...] = ()
    reason: str = ""


# ─────────────────────────────────────────────────────────────────────────────
# Default model selection per (provider, complexity).
# Kept here rather than per-provider so reviewers see the full matrix at once.
# ─────────────────────────────────────────────────────────────────────────────

_MODELS: dict[str, dict[ComplexityClass, str]] = {
    "webllm": {
        ComplexityClass.simple: "llama-3.2-3b-instruct",
    },
    "groq": {
        ComplexityClass.simple: "llama-3.1-8b-instant",
        ComplexityClass.medium: "llama-3.3-70b-versatile",
        ComplexityClass.code: "llama-3.3-70b-versatile",
        ComplexityClass.complex: "llama-3.3-70b-versatile",
        ComplexityClass.multi_doc: "llama-3.3-70b-versatile",
    },
    "gemini_free": {
        ComplexityClass.simple: "gemini-2.5-flash",
        ComplexityClass.medium: "gemini-2.5-flash",
        ComplexityClass.code: "gemini-2.5-flash",
        ComplexityClass.complex: "gemini-2.5-pro",
        ComplexityClass.multi_doc: "gemini-2.5-pro",
    },
    "openrouter_free": {
        ComplexityClass.simple: "mistralai/mistral-7b-instruct:free",
        ComplexityClass.medium: "qwen/qwen-2.5-72b-instruct:free",
        ComplexityClass.code: "qwen/qwen-2.5-coder-32b-instruct:free",
        ComplexityClass.complex: "qwen/qwen-2.5-72b-instruct:free",
        ComplexityClass.multi_doc: "qwen/qwen-2.5-72b-instruct:free",
    },
    "anthropic": {
        ComplexityClass.simple: "claude-haiku-4-5-20251001",
        ComplexityClass.medium: "claude-sonnet-4-6",
        ComplexityClass.code: "claude-sonnet-4-6",
        ComplexityClass.complex: "claude-opus-4-7",
        ComplexityClass.multi_doc: "claude-opus-4-7",
    },
    "openai": {
        ComplexityClass.simple: "gpt-4o-mini",
        ComplexityClass.medium: "gpt-4o",
        ComplexityClass.code: "gpt-4o",
        ComplexityClass.complex: "gpt-4o",
        ComplexityClass.multi_doc: "gpt-4o",
    },
}

# Free-first preference per complexity class. ``webllm`` precedes everything
# because it's literally $0 to the platform.
_FREE_PROVIDERS_BY_CLASS: dict[ComplexityClass, tuple[str, ...]] = {
    ComplexityClass.simple: ("webllm", "groq", "gemini_free", "openrouter_free"),
    ComplexityClass.medium: ("groq", "gemini_free", "openrouter_free"),
    ComplexityClass.code: ("openrouter_free", "groq", "gemini_free"),
    ComplexityClass.complex: ("gemini_free",),
    ComplexityClass.multi_doc: ("gemini_free",),
}

_PAID_FALLBACK_BY_CLASS: dict[ComplexityClass, tuple[str, ...]] = {
    ComplexityClass.simple: ("anthropic", "openai"),
    ComplexityClass.medium: ("anthropic", "openai"),
    ComplexityClass.code: ("anthropic", "openai"),
    ComplexityClass.complex: ("anthropic", "openai"),
    ComplexityClass.multi_doc: ("gemini_free", "anthropic", "openai"),
}


def decide_route(
    *,
    complexity: ComplexityClass,
    budget: BudgetDecision,
    providers: dict[str, ProviderHealth],
    byok_provider: str | None = None,
    credits: list[CreditBalance] | None = None,
) -> RouteResult:
    """Pure function. No side effects. Returns the ordered candidate list."""
    credits = credits or []
    # 1. BYOK wins outright. If the underlying provider isn't in our model
    #    matrix (e.g. an exotic OpenRouter slug), default to "default" so the
    #    provider adapter chooses its preferred model.
    if byok_provider is not None:
        model = _model_for(byok_provider, complexity) or "default"
        return RouteResult(
            status="allow",
            candidates=(
                RouteCandidate(
                    provider_id="user_byok",
                    model=model,
                    reason=f"BYOK present (underlying provider={byok_provider})",
                    cacheable=True,
                ),
            ),
        )

    # 2. Credit balances next — preferred over the platform's free tier so the
    #    student gets frontier quality at zero platform cost.
    credit_candidates = _credit_candidates(credits, complexity, providers)

    # 3. Free-tier providers (in priority order).
    free_candidates = _free_candidates(complexity, providers, budget)

    # 4. Paid fallback only if budget allows.
    paid_candidates: tuple[RouteCandidate, ...] = ()
    if budget.kind in (DecisionKind.allow, DecisionKind.warn, DecisionKind.downshift):
        if budget.kind is DecisionKind.downshift or not free_candidates:
            paid_candidates = _paid_candidates(complexity, providers)

    if budget.kind is DecisionKind.rate_limit and not free_candidates and not credit_candidates:
        return RouteResult(status="rate_limited", reason=budget.reason)
    if budget.kind is DecisionKind.block:
        return RouteResult(status="blocked", reason=budget.reason)

    candidates = credit_candidates + free_candidates + paid_candidates
    if not candidates:
        # Belt + braces: should be unreachable given budget=allow/warn implies
        # at least one free provider survives. If we get here, surface a typed
        # error so the orchestrator records it on the run.
        return RouteResult(status="blocked", reason="no providers available")
    return RouteResult(status="allow", candidates=candidates, reason=budget.reason)


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────


def _credit_candidates(
    credits: list[CreditBalance],
    complexity: ComplexityClass,
    providers: dict[str, ProviderHealth],
) -> tuple[RouteCandidate, ...]:
    out: list[RouteCandidate] = []
    for credit in credits:
        if credit.tokens_remaining == 0:
            continue
        health = providers.get(credit.provider_id)
        if health is None or not health.healthy:
            continue
        model = _model_for(credit.provider_id, complexity)
        if model is None:
            continue
        out.append(
            RouteCandidate(
                provider_id=credit.provider_id,
                model=model,
                reason=f"credit balance ({credit.program_name})",
                cacheable=True,
            )
        )
    return tuple(out)


def _free_candidates(
    complexity: ComplexityClass,
    providers: dict[str, ProviderHealth],
    budget: BudgetDecision,
) -> tuple[RouteCandidate, ...]:
    # Honour budget's suggested order when present (lets a tier policy override
    # the default free-first preference for an institutional contract).
    preferred = (
        budget.suggested_providers
        if budget.suggested_providers
        else _FREE_PROVIDERS_BY_CLASS.get(complexity, ())
    )
    out: list[RouteCandidate] = []
    for provider_id in preferred:
        if provider_id not in _FREE_PROVIDERS_BY_CLASS.get(complexity, ()) and provider_id != "user_byok":
            # Suggested providers from a non-free policy fall through to the paid path.
            continue
        health = providers.get(provider_id)
        if health is None or not health.healthy:
            continue
        if health.tokens_remaining == 0:
            continue
        model = _model_for(provider_id, complexity)
        if model is None:
            continue
        out.append(
            RouteCandidate(
                provider_id=provider_id,
                model=model,
                reason="free-tier provider with quota",
                cacheable=True,
            )
        )
    return tuple(out)


def _paid_candidates(
    complexity: ComplexityClass,
    providers: dict[str, ProviderHealth],
) -> tuple[RouteCandidate, ...]:
    out: list[RouteCandidate] = []
    for provider_id in _PAID_FALLBACK_BY_CLASS.get(complexity, ()):
        health = providers.get(provider_id)
        if health is None or not health.healthy:
            continue
        model = _model_for(provider_id, complexity)
        if model is None:
            continue
        out.append(
            RouteCandidate(
                provider_id=provider_id,
                model=model,
                reason="paid fallback",
                cacheable=True,
            )
        )
    return tuple(out)


def _model_for(provider_id: str, complexity: ComplexityClass) -> str | None:
    table = _MODELS.get(provider_id)
    if table is None:
        return None
    return table.get(complexity)
