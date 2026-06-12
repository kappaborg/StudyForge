"""Anthropic provider adapter.

Anthropic's ``/v1/messages`` API doesn't follow the OpenAI shape:
  * ``system`` is a top-level field, not a role inside ``messages``
  * ``messages`` alternates between ``user`` and ``assistant`` only
  * Response ``content`` is an array of content blocks ``[{type: "text", text}]``
  * Token usage uses ``input_tokens`` / ``output_tokens``
  * Streaming uses Anthropic-specific SSE event types (``content_block_delta``)

This module owns the translation. Streaming is not wired in Phase 1 #6 — the
``stream`` Protocol method raises ``NotImplementedError`` until Phase 1 mid
adds the Anthropic SSE event handler. ``complete()`` is fully functional.

Prompt caching is supported via the ``cache_control`` extension. The router
sets ``LLMRequest.cache_prefix_boundary`` when it wants the first N messages
cached; this adapter translates that into the ``cache_control: {type:
"ephemeral"}`` marker on the last system / user block in that range.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

import httpx

from .contracts import (
    ChannelMessage,
    LLMRequest,
    LLMResponse,
    LLMStreamChunk,
    LLMUsage,
)

ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1"
ANTHROPIC_VERSION = "2023-06-01"


class AnthropicProvider:
    id: str = "anthropic"
    supports_prompt_cache: bool = True
    supports_streaming: bool = True
    context_window_tokens: int = 200_000  # Claude 4 family context

    def __init__(
        self,
        api_key: str,
        *,
        base_url: str = ANTHROPIC_BASE_URL,
        http: httpx.AsyncClient | None = None,
        timeout_s: float = 30.0,
    ) -> None:
        if not api_key:
            raise ValueError("anthropic api_key is required")
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._owns_client = http is None
        self._http = http if http is not None else httpx.AsyncClient(timeout=timeout_s)

    async def aclose(self) -> None:
        if self._owns_client:
            await self._http.aclose()

    async def complete(self, req: LLMRequest) -> LLMResponse:
        payload = build_messages_payload(req, stream=False)
        response = await self._http.post(
            f"{self._base_url}/messages",
            headers=self._headers(),
            json=payload,
        )
        raise_for_status(response)
        body = response.json()
        return parse_messages_response(body, model_fallback=req.model)

    def stream(self, req: LLMRequest) -> AsyncIterator[LLMStreamChunk]:
        # Anthropic's SSE format differs from OpenAI's — Phase 1 mid wires it.
        raise NotImplementedError("AnthropicProvider.stream is implemented in Phase 1 mid")

    async def ping(self) -> dict[str, object]:
        import time

        started = time.perf_counter()
        try:
            # Anthropic doesn't have a public ``/models`` for probing; the
            # cheapest cheap check is a HEAD against the API root, but that
            # 404s. We instead do a tiny ``messages`` call with max_tokens=1.
            await self._http.post(
                f"{self._base_url}/messages",
                headers=self._headers(),
                json={
                    "model": "claude-haiku-4-5-20251001",
                    "max_tokens": 1,
                    "messages": [{"role": "user", "content": "ping"}],
                },
                timeout=5,
            )
            return {"ok": True, "latency_ms": int((time.perf_counter() - started) * 1000)}
        except Exception:
            return {"ok": False, "latency_ms": int((time.perf_counter() - started) * 1000)}

    def _headers(self) -> dict[str, str]:
        return {
            "x-api-key": self._api_key,
            "anthropic-version": ANTHROPIC_VERSION,
            "content-type": "application/json",
            "accept": "application/json",
        }


# ─────────────────────────────────────────────────────────────────────────────
# Pure helpers — payload + response translators, exported for unit tests
# ─────────────────────────────────────────────────────────────────────────────


def build_messages_payload(req: LLMRequest, *, stream: bool) -> dict[str, Any]:
    """Translate the provider-agnostic ``LLMRequest`` into Anthropic's
    ``/v1/messages`` body shape.

    * Collapses any ``system`` messages into the top-level ``system`` field.
    * Strips ``tool`` messages (Anthropic's tool-use format is shape-different
      and is wired separately in Phase 2).
    * Maps remaining roles to Anthropic's user / assistant alternation.
    """
    system_parts: list[str] = []
    messages: list[dict[str, Any]] = []
    for msg in req.messages:
        if msg.role == "system":
            system_parts.append(msg.content)
            continue
        if msg.role == "tool":
            # Tool-message format is wired separately in Phase 2.
            continue
        # Anthropic supports only user + assistant in the role array.
        messages.append({"role": msg.role, "content": msg.content})

    body: dict[str, Any] = {
        "model": req.model,
        "max_tokens": req.max_output_tokens,
        "temperature": req.temperature,
        "messages": messages,
        "stream": stream,
    }
    if system_parts:
        system_block: Any = "\n\n".join(system_parts)
        if req.cache_prefix_boundary is not None:
            # Anthropic accepts a structured `system` array with cache markers.
            system_block = [
                {
                    "type": "text",
                    "text": "\n\n".join(system_parts),
                    "cache_control": {"type": "ephemeral"},
                }
            ]
        body["system"] = system_block
    if req.stop is not None:
        body["stop_sequences"] = req.stop
    if req.user is not None:
        body["metadata"] = {"user_id": req.user}
    return body


def parse_messages_response(body: dict[str, Any], *, model_fallback: str) -> LLMResponse:
    """Translate Anthropic's response into the provider-agnostic shape."""
    content_blocks = body.get("content") or []
    text = _concat_text_blocks(content_blocks)
    stop_reason = str(body.get("stop_reason") or "stop")
    return LLMResponse(
        text=text,
        finish_reason=_normalise_stop_reason(stop_reason),
        usage=_extract_anthropic_usage(body),
        model=str(body.get("model") or model_fallback),
        provider_id="anthropic",
    )


def _concat_text_blocks(blocks: list[Any]) -> str:
    parts: list[str] = []
    for block in blocks:
        if not isinstance(block, dict):
            continue
        if block.get("type") == "text":
            parts.append(str(block.get("text") or ""))
    return "".join(parts)


def _normalise_stop_reason(raw: str) -> str:
    # Map Anthropic finish reasons to the OpenAI-style values the rest of the
    # platform expects.
    mapping = {
        "end_turn": "stop",
        "max_tokens": "length",
        "stop_sequence": "stop",
        "tool_use": "tool_calls",
    }
    return mapping.get(raw, raw)


def _extract_anthropic_usage(body: dict[str, Any]) -> LLMUsage:
    """Translate Anthropic's usage block to the provider-agnostic shape.

    Anthropic reports cached input tokens under ``cache_read_input_tokens``.
    Anthropic charges these at ~10% of the regular input rate, so the cost
    ledger uses ``cached_tokens_in`` to compute the actual billed cost rather
    than treating every input token as full-price.
    """
    usage = body.get("usage") or {}
    cache_read = int(usage.get("cache_read_input_tokens", 0) or 0)
    return LLMUsage(
        tokens_in=int(usage.get("input_tokens", 0) or 0),
        tokens_out=int(usage.get("output_tokens", 0) or 0),
        cached_tokens_in=cache_read,
        cache_hit=cache_read > 0,
    )


def raise_for_status(response: httpx.Response) -> None:
    if response.status_code >= 400:
        text = response.text[:400] if response.text else "<empty>"
        raise AnthropicRequestError(
            status=response.status_code,
            message=f"Anthropic returned {response.status_code}: {text}",
        )


# Re-exported for callers that catch by symbol.
class AnthropicRequestError(RuntimeError):
    def __init__(self, *, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


# Keep ChannelMessage / LLMStreamChunk imported — they document the Protocol
# surface this module satisfies, even though they aren't referenced by name.
__all__ = [
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_VERSION",
    "AnthropicProvider",
    "AnthropicRequestError",
    "ChannelMessage",
    "LLMStreamChunk",
    "build_messages_payload",
    "parse_messages_response",
]
