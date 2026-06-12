"""Cerebras provider adapter.

Cerebras Inference at ``api.cerebras.ai/v1`` hosts Llama 3.3 with
extremely fast TTFT thanks to wafer-scale silicon. Free tier:
generous daily token budget. OpenAI-compatible.
"""

from __future__ import annotations

from .openai_compat import OpenAICompatibleProvider

CEREBRAS_BASE_URL = "https://api.cerebras.ai/v1"


class CerebrasProvider(OpenAICompatibleProvider):
    id: str = "cerebras"
    base_url: str = CEREBRAS_BASE_URL
    supports_prompt_cache: bool = False
    supports_streaming: bool = True
    context_window_tokens: int = 8_192  # Cerebras-hosted Llama 3.3 8K context
