"""OpenRouter provider adapter.

OpenRouter aggregates ~200 models behind a single OpenAI-compatible API.
For the free tier we route to models with ``:free`` suffix
(e.g. ``meta-llama/llama-3.3-8b-instruct:free``). Prompt caching is
provider-side (Anthropic models routed through OpenRouter honour
cache_control) but the router doesn't need to mark anything — OpenRouter
forwards the body.

OpenRouter requires the ``HTTP-Referer`` + ``X-Title`` headers to display
the calling app in their dashboard. They aren't strictly mandatory but
omitting them risks getting rate-limit-coalesced with other anonymous
traffic, which is the worst kind of free-tier failure mode.
"""

from __future__ import annotations

import httpx

from .openai_compat import OpenAICompatibleProvider

OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"


class OpenRouterProvider(OpenAICompatibleProvider):
    id: str = "openrouter"
    base_url: str = OPENROUTER_BASE_URL
    supports_prompt_cache: bool = True
    supports_streaming: bool = True
    context_window_tokens: int = 32_768

    def __init__(
        self,
        api_key: str,
        *,
        base_url: str | None = None,
        http: httpx.AsyncClient | None = None,
        timeout_s: float = 30.0,
        app_url: str = "https://study-forge-web.vercel.app",
        app_title: str = "StudyForge",
    ) -> None:
        super().__init__(api_key, base_url=base_url, http=http, timeout_s=timeout_s)
        self._app_url = app_url
        self._app_title = app_title

    def _headers(self) -> dict[str, str]:
        base = super()._headers()
        base["http-referer"] = self._app_url
        base["x-title"] = self._app_title
        return base
