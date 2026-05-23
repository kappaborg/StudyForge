"""LLM provider registry.

Maps the ``provider_id`` strings emitted by ``cost.decide_route`` to live
adapter instances. The orchestrator and the tutor agent never construct
adapters themselves — they ask the registry. This is the single place where
provider credentials and base URLs are wired.

The registry is built once at boot and exposes:

  * ``get(provider_id)``           — returns the adapter or raises ``KeyError``
  * ``available_provider_ids()``   — for routing decisions that need to know
                                     which adapters are actually configured
  * ``aclose()``                   — closes underlying HTTP clients
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from .anthropic import AnthropicProvider
from .contracts import LLMProvider
from .groq import GroqProvider
from .openai import OpenAIProvider

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class ProviderCredentials:
    """Env-supplied credentials. Empty strings mean "not configured" — the
    registry skips the adapter."""

    groq_api_key: str | None = None
    openai_api_key: str | None = None
    anthropic_api_key: str | None = None


class ProviderRegistry:
    """One adapter per configured provider. Closed on shutdown."""

    def __init__(self, creds: ProviderCredentials) -> None:
        self._adapters: dict[str, LLMProvider] = {}
        self._owns: list[LLMProvider] = []

        if creds.groq_api_key:
            self._adapters["groq"] = GroqProvider(api_key=creds.groq_api_key)
            self._owns.append(self._adapters["groq"])

        if creds.openai_api_key:
            self._adapters["openai"] = OpenAIProvider(api_key=creds.openai_api_key)
            self._owns.append(self._adapters["openai"])

        if creds.anthropic_api_key:
            self._adapters["anthropic"] = AnthropicProvider(api_key=creds.anthropic_api_key)
            self._owns.append(self._adapters["anthropic"])

        log.info(
            "llm.registry initialised with adapters: %s",
            sorted(self._adapters.keys()) or "[none]",
        )

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

    async def aclose(self) -> None:
        for adapter in self._owns:
            close = getattr(adapter, "aclose", None)
            if callable(close):
                try:
                    await close()
                except Exception:  # noqa: BLE001 — shutdown is best-effort
                    log.exception("error closing provider %s", getattr(adapter, "id", "?"))
