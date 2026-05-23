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
