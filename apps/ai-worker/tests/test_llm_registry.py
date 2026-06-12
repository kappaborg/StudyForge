"""ProviderRegistry — env-driven adapter wiring."""

from __future__ import annotations

import pytest

from src.llm.registry import ProviderCredentials, ProviderRegistry


def test_registry_includes_only_configured_providers() -> None:
    creds = ProviderCredentials(groq_api_key="gsk-test")
    reg = ProviderRegistry(creds)
    assert reg.available_provider_ids() == ["groq"]
    assert reg.has("groq")
    assert not reg.has("openai")
    assert not reg.has("anthropic")


def test_registry_includes_all_three_when_all_keys_set() -> None:
    creds = ProviderCredentials(
        groq_api_key="gsk-x",
        openai_api_key="sk-x",
        anthropic_api_key="sk-ant-x",
    )
    reg = ProviderRegistry(creds)
    assert reg.available_provider_ids() == ["anthropic", "groq", "openai"]


def test_registry_get_returns_correct_adapter() -> None:
    creds = ProviderCredentials(groq_api_key="gsk-x", openai_api_key="sk-x")
    reg = ProviderRegistry(creds)
    groq = reg.get("groq")
    openai = reg.get("openai")
    assert groq.id == "groq"
    assert openai.id == "openai"


def test_registry_raises_keyerror_for_unconfigured_provider() -> None:
    reg = ProviderRegistry(ProviderCredentials(groq_api_key="gsk-x"))
    with pytest.raises(KeyError) as exc:
        reg.get("anthropic")
    assert "anthropic" in str(exc.value)
    assert "available" in str(exc.value)


def test_registry_with_no_credentials_is_empty() -> None:
    reg = ProviderRegistry(ProviderCredentials())
    assert reg.available_provider_ids() == []


@pytest.mark.asyncio
async def test_registry_aclose_is_safe_when_empty() -> None:
    reg = ProviderRegistry(ProviderCredentials())
    await reg.aclose()  # must not raise


@pytest.mark.asyncio
async def test_registry_aclose_closes_owned_clients() -> None:
    reg = ProviderRegistry(
        ProviderCredentials(
            groq_api_key="gsk-x",
            openai_api_key="sk-x",
            anthropic_api_key="sk-ant-x",
        )
    )
    await reg.aclose()


# ─────────────────────────────────────────────────────────────────────────────
# Phase B-1 — 5 new OpenAI-compatible free-tier adapters
# ─────────────────────────────────────────────────────────────────────────────


def test_registry_wires_openrouter_when_key_present() -> None:
    reg = ProviderRegistry(ProviderCredentials(openrouter_api_key="sk-or-x"))
    assert reg.has("openrouter")
    assert reg.get("openrouter").id == "openrouter"


def test_registry_wires_cerebras_when_key_present() -> None:
    reg = ProviderRegistry(ProviderCredentials(cerebras_api_key="csk-x"))
    assert reg.has("cerebras")
    assert reg.get("cerebras").id == "cerebras"


def test_registry_wires_together_when_key_present() -> None:
    reg = ProviderRegistry(ProviderCredentials(together_api_key="tg-x"))
    assert reg.has("together")
    assert reg.get("together").id == "together"


def test_registry_wires_fireworks_when_key_present() -> None:
    reg = ProviderRegistry(ProviderCredentials(fireworks_api_key="fw-x"))
    assert reg.has("fireworks")
    assert reg.get("fireworks").id == "fireworks"


def test_registry_wires_ollama_only_when_explicitly_enabled() -> None:
    """Ollama doesn't authenticate, so the registry can't tell from
    credentials whether the local daemon is running. Opt-in is explicit."""
    off = ProviderRegistry(ProviderCredentials())
    on = ProviderRegistry(ProviderCredentials(enable_ollama=True))
    assert not off.has("ollama")
    assert on.has("ollama")
    assert on.get("ollama").id == "ollama"


def test_registry_wires_gemini_when_key_present() -> None:
    reg = ProviderRegistry(ProviderCredentials(gemini_api_key="AIza-x"))
    assert reg.has("gemini")
    assert reg.get("gemini").id == "gemini"


def test_registry_with_all_providers_lists_all() -> None:
    reg = ProviderRegistry(
        ProviderCredentials(
            groq_api_key="gsk-x",
            gemini_api_key="AIza-x",
            openai_api_key="sk-x",
            anthropic_api_key="sk-ant-x",
            openrouter_api_key="sk-or-x",
            cerebras_api_key="csk-x",
            together_api_key="tg-x",
            fireworks_api_key="fw-x",
            enable_ollama=True,
        )
    )
    assert reg.available_provider_ids() == [
        "anthropic",
        "cerebras",
        "fireworks",
        "gemini",
        "groq",
        "ollama",
        "openai",
        "openrouter",
        "together",
    ]


# ─────────────────────────────────────────────────────────────────────────────
# Free-tier preference ordering (§13.1)
# ─────────────────────────────────────────────────────────────────────────────


def test_preferred_free_provider_picks_groq_first_when_configured() -> None:
    reg = ProviderRegistry(
        ProviderCredentials(
            groq_api_key="gsk-x",
            openai_api_key="sk-x",
            anthropic_api_key="sk-ant-x",
        )
    )
    picked = reg.preferred_free_provider()
    assert picked is not None
    assert picked.id == "groq"


def test_preferred_free_provider_picks_gemini_second_when_no_groq() -> None:
    reg = ProviderRegistry(
        ProviderCredentials(
            gemini_api_key="AIza-x",
            cerebras_api_key="csk-x",
            openai_api_key="sk-x",
        )
    )
    picked = reg.preferred_free_provider()
    assert picked is not None
    assert picked.id == "gemini"


def test_preferred_free_provider_falls_through_to_cerebras_when_no_groq_or_gemini() -> None:
    reg = ProviderRegistry(
        ProviderCredentials(
            cerebras_api_key="csk-x",
            openai_api_key="sk-x",
            anthropic_api_key="sk-ant-x",
        )
    )
    picked = reg.preferred_free_provider()
    assert picked is not None
    assert picked.id == "cerebras"


def test_preferred_free_provider_paid_providers_are_last_resort() -> None:
    # OpenAI / Anthropic are the bottom of the preference list — only
    # picked when no free provider is configured.
    reg = ProviderRegistry(
        ProviderCredentials(anthropic_api_key="sk-ant-x", openai_api_key="sk-x")
    )
    picked = reg.preferred_free_provider()
    assert picked is not None
    assert picked.id == "openai"  # openai before anthropic per §13.1


def test_preferred_free_provider_returns_none_when_nothing_configured() -> None:
    reg = ProviderRegistry(ProviderCredentials())
    assert reg.preferred_free_provider() is None
