"""Together AI provider adapter.

Together hosts Llama, Mistral, Qwen, DeepSeek under the OpenAI-compatible
shape at ``api.together.xyz/v1``. Free tier: $1 credit + occasional free
models (``meta-llama/Llama-3.3-70B-Instruct-Turbo-Free``). No prompt
caching surface.
"""

from __future__ import annotations

from .openai_compat import OpenAICompatibleProvider

TOGETHER_BASE_URL = "https://api.together.xyz/v1"


class TogetherProvider(OpenAICompatibleProvider):
    id: str = "together"
    base_url: str = TOGETHER_BASE_URL
    supports_prompt_cache: bool = False
    supports_streaming: bool = True
    context_window_tokens: int = 131_072  # Llama 3.3 70B native context
