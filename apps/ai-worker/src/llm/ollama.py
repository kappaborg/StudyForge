"""Ollama provider adapter.

Ollama exposes an OpenAI-compatible endpoint at ``/v1/chat/completions``
on the local machine. Self-hosted, free, but slow on CPU. Used in dev
and as the ``self_hosted`` route in the §13.1 cost policy when no other
free provider is reachable.

Ollama does not authenticate — the api_key is ignored. We still pass it
through ``OpenAICompatibleProvider`` to keep the construction signature
uniform; ``OLLAMA_NOAUTH`` is the sentinel.
"""

from __future__ import annotations

from .openai_compat import OpenAICompatibleProvider

OLLAMA_DEFAULT_BASE_URL = "http://localhost:11434/v1"


class OllamaProvider(OpenAICompatibleProvider):
    id: str = "ollama"
    base_url: str = OLLAMA_DEFAULT_BASE_URL
    supports_prompt_cache: bool = False
    supports_streaming: bool = True
    context_window_tokens: int = 8_192
    auth_header: str = "authorization"
    auth_value_template: str = "Bearer {key}"
