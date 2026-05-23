# ADR-0002: LLM router is free-tier-first and the only path to providers

## Status

Accepted (2026-05-21).

## Context

The platform must remain free or near-free for students. LLM tokens dominate variable cost. A naive "use OpenAI for everything" architecture defeats this immediately. We also need provider failover for reliability.

## Decision

1. Every LLM and embedding call goes through `packages/llm-router`. Direct provider SDK usage in application code is forbidden and enforced by lint rule and code review.
2. The router's default policy is **free-tier-first**: `webllm`, `ollama`, `groq`, `gemini_free`, `hf_inference`, `openrouter_free`, `cerebras`, `together`, `fireworks`, then paid providers (`gemini`, `anthropic`, `openai`). Order is data-driven by complexity class.
3. Paid providers are reached only when (a) BYOK is present, (b) tier is Pro/Institutional and complexity warrants it, or (c) all preferred providers are unavailable.
4. Every call writes a `UsageEvent` row carrying tenant, user, provider, tokens, cache state, and USD-equivalent cost. This is the source of truth for billing, quota, and cost dashboards.
5. Prompt caching, semantic caching, and course-shared artifact caching are first-class router responsibilities, not optional plug-ins.

## Consequences

- A new provider integration is a single `Provider` implementation behind the abstraction. No application code changes.
- Cost reporting is a SQL query over `UsageEvent`, not a per-provider scrape.
- Onboarding a new agent (e.g. a future "exam-coach") inherits the cost discipline by construction.
- The router is a high-blast-radius component and is held to a higher review and test bar than ordinary application code.
