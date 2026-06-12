"""LLM provider registry.

Maps the ``provider_id`` strings emitted by ``cost.decide_route`` to live
adapter instances. The orchestrator and the tutor agent never construct
adapters themselves — they ask the registry. This is the single place where
provider credentials and base URLs are wired.

The registry is built once at boot and exposes:

  * ``get(provider_id)``           — returns the adapter or raises ``KeyError``
  * ``available_provider_ids()``   — for routing decisions that need to know
                                     which adapters are actually configured
  * ``preferred_free_provider()``  — first available provider in the §13.1
                                     free-tier preference order
  * ``aclose()``                   — closes underlying HTTP clients
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from .anthropic import AnthropicProvider
from .cerebras import CerebrasProvider
from .contracts import LLMProvider
from .fireworks import FireworksProvider
from .gemini import GeminiProvider
from .groq import GroqProvider
from .ollama import OllamaProvider
from .openai import OpenAIProvider
from .openrouter import OpenRouterProvider
from .together import TogetherProvider

log = logging.getLogger(__name__)

# §13.1 cost-routing preference. Free + fastest first; paid + most capable
# last. The router falls through this list to find the first configured
# adapter when no specific provider was requested.
FREE_TIER_PREFERENCE: tuple[str, ...] = (
    "groq",
    "gemini",
    "cerebras",
    "openrouter",
    "together",
    "fireworks",
    "ollama",
    "openai",
    "anthropic",
)


@dataclass(frozen=True)
class ProviderCredentials:
    """Env-supplied credentials. None means "not configured" — the registry
    skips the adapter rather than failing to boot."""

    groq_api_key: str | None = None
    gemini_api_key: str | None = None
    openai_api_key: str | None = None
    anthropic_api_key: str | None = None
    openrouter_api_key: str | None = None
    cerebras_api_key: str | None = None
    together_api_key: str | None = None
    fireworks_api_key: str | None = None
    # Ollama doesn't authenticate. ``enable_ollama`` toggles registration;
    # ``ollama_base_url`` overrides the localhost default for remote ollama.
    enable_ollama: bool = False
    ollama_base_url: str | None = None


class ProviderRegistry:
    """One adapter per configured provider. Closed on shutdown."""

    def __init__(self, creds: ProviderCredentials) -> None:
        self._adapters: dict[str, LLMProvider] = {}
        self._owns: list[LLMProvider] = []

        if creds.groq_api_key:
            self._register("groq", GroqProvider(api_key=creds.groq_api_key))

        if creds.gemini_api_key:
            self._register("gemini", GeminiProvider(api_key=creds.gemini_api_key))

        if creds.openai_api_key:
            self._register("openai", OpenAIProvider(api_key=creds.openai_api_key))

        if creds.anthropic_api_key:
            self._register("anthropic", AnthropicProvider(api_key=creds.anthropic_api_key))

        if creds.openrouter_api_key:
            self._register("openrouter", OpenRouterProvider(api_key=creds.openrouter_api_key))

        if creds.cerebras_api_key:
            self._register("cerebras", CerebrasProvider(api_key=creds.cerebras_api_key))

        if creds.together_api_key:
            self._register("together", TogetherProvider(api_key=creds.together_api_key))

        if creds.fireworks_api_key:
            self._register("fireworks", FireworksProvider(api_key=creds.fireworks_api_key))

        if creds.enable_ollama:
            self._register(
                "ollama",
                OllamaProvider(
                    api_key="ollama-noauth",
                    base_url=creds.ollama_base_url,
                ),
            )

        log.info(
            "llm.registry initialised with adapters: %s",
            sorted(self._adapters.keys()) or "[none]",
        )

    def _register(self, provider_id: str, adapter: LLMProvider) -> None:
        self._adapters[provider_id] = adapter
        self._owns.append(adapter)

    def get(self, provider_id: str) -> LLMProvider:
        try:
            return self._adapters[provider_id]
        except KeyError as exc:
            raise KeyError(
                f"provider {provider_id!r} is not configured "
                f"(available: {sorted(self._adapters.keys())})"
            ) from exc

    def available_provider_ids(self) -> list[str]:
        return sorted(self._adapters.keys())

    def has(self, provider_id: str) -> bool:
        return provider_id in self._adapters

    def preferred_free_provider(self) -> LLMProvider | None:
        """First configured adapter in the §13.1 free-tier preference order.

        Returns ``None`` when no provider is configured — callers should
        fall back to the stub response path (the tutor demonstrates this
        pattern). Used by the default-provider builder during boot when
        no specific provider is pinned.
        """
        for provider_id in FREE_TIER_PREFERENCE:
            adapter = self._adapters.get(provider_id)
            if adapter is not None:
                return adapter
        return None

    async def aclose(self) -> None:
        for adapter in self._owns:
            close = getattr(adapter, "aclose", None)
            if callable(close):
                try:
                    await close()
                except Exception:
                    log.exception("error closing provider %s", getattr(adapter, "id", "?"))
