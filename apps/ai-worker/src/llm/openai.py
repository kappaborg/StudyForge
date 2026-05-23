"""OpenAI provider adapter.

Thin specialisation of ``OpenAICompatibleProvider``. The shared transport in
``openai_compat`` handles the wire format end to end; this class only sets
the OpenAI-specific id, base URL, context window, and prompt-cache support
flag (OpenAI applies automatic prompt caching when prefixes stay stable —
the router doesn't need to mark cache prefixes for OpenAI).
"""

from __future__ import annotations

from .openai_compat import OpenAICompatibleProvider

OPENAI_BASE_URL = "https://api.openai.com/v1"


class OpenAIProvider(OpenAICompatibleProvider):
    id: str = "openai"
    base_url: str = OPENAI_BASE_URL
    # Automatic prompt caching is built into OpenAI's chat-completions
    # endpoint (no explicit cache_control marker required).
    supports_prompt_cache: bool = True
    supports_streaming: bool = True
    context_window_tokens: int = 128_000  # gpt-4o context window
