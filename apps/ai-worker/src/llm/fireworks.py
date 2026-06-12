"""Fireworks AI provider adapter.

Fireworks hosts Llama, Mixtral, Qwen, DeepSeek with very fast TTFT under
the OpenAI-compatible shape at ``api.fireworks.ai/inference/v1``.
Free tier: $1 credit + generous rate-limited free models.
"""

from __future__ import annotations

from .openai_compat import OpenAICompatibleProvider

FIREWORKS_BASE_URL = "https://api.fireworks.ai/inference/v1"


class FireworksProvider(OpenAICompatibleProvider):
    id: str = "fireworks"
    base_url: str = FIREWORKS_BASE_URL
    supports_prompt_cache: bool = False
    supports_streaming: bool = True
    context_window_tokens: int = 131_072
