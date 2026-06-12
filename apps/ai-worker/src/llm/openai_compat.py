"""Shared transport for OpenAI-compatible chat-completions endpoints.

Groq, OpenAI, OpenRouter, Together, Fireworks, Cerebras, and most other
free-tier providers in §13.1 expose the same OpenAI-style ``/chat/completions``
shape. Rather than duplicate the payload builder + response parser + SSE
framing across six adapters, this module owns them and each concrete adapter
is a ~20-line specialisation that sets the base URL, the provider id, the
context window, and optional adapter quirks.

The pure functions are exported for unit tests; the ``OpenAICompatibleProvider``
class is the orchestrator-facing API.
"""

from __future__ import annotations

import json
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

# ─────────────────────────────────────────────────────────────────────────────
# Pure helpers (export for unit tests)
# ─────────────────────────────────────────────────────────────────────────────


def build_chat_payload(req: LLMRequest, *, stream: bool) -> dict[str, Any]:
    body: dict[str, Any] = {
        "model": req.model,
        "messages": [_to_openai_message(m) for m in req.messages],
        "temperature": req.temperature,
        "max_tokens": req.max_output_tokens,
        "stream": stream,
    }
    if req.stop is not None:
        body["stop"] = req.stop
    if req.user is not None:
        body["user"] = req.user
    if stream:
        body["stream_options"] = {"include_usage": True}
    return body


def parse_completion(body: dict[str, Any], *, provider_id: str, model_fallback: str) -> LLMResponse:
    choices = body.get("choices") or []
    if not choices:
        raise OpenAICompatRequestError(
            status=500,
            message=f"{provider_id} response missing choices",
        )
    choice = choices[0]
    message = choice.get("message") or {}
    text = str(message.get("content") or "")
    finish = str(choice.get("finish_reason") or "stop")
    return LLMResponse(
        text=text,
        finish_reason=finish,
        usage=extract_usage(body),
        model=str(body.get("model") or model_fallback),
        provider_id=provider_id,
    )


def extract_usage(body: dict[str, Any]) -> LLMUsage:
    """Parse the ``usage`` block from an OpenAI-style chat-completions response.

    OpenAI reports cached input tokens under
    ``usage.prompt_tokens_details.cached_tokens`` once automatic prompt
    caching engages. Groq doesn't populate this field, so callers there see
    ``cached_tokens_in = 0`` / ``cache_hit = False``.
    """
    usage = body.get("usage") or {}
    details = usage.get("prompt_tokens_details") or {}
    cached = int(details.get("cached_tokens", 0) or 0)
    return LLMUsage(
        tokens_in=int(usage.get("prompt_tokens", 0) or 0),
        tokens_out=int(usage.get("completion_tokens", 0) or 0),
        cached_tokens_in=cached,
        cache_hit=cached > 0,
    )


def parse_stream_chunk(obj: dict[str, Any]) -> tuple[str, str | None]:
    choices = obj.get("choices") or []
    if not choices:
        return "", None
    choice = choices[0]
    delta = (choice.get("delta") or {}).get("content")
    finish = choice.get("finish_reason")
    return str(delta or ""), finish if isinstance(finish, str) else None


def maybe_usage(obj: dict[str, Any]) -> LLMUsage | None:
    usage = obj.get("usage")
    if not isinstance(usage, dict):
        return None
    details = usage.get("prompt_tokens_details") or {}
    cached = int(details.get("cached_tokens", 0) or 0)
    return LLMUsage(
        tokens_in=int(usage.get("prompt_tokens", 0) or 0),
        tokens_out=int(usage.get("completion_tokens", 0) or 0),
        cached_tokens_in=cached,
        cache_hit=cached > 0,
    )


def _to_openai_message(msg: ChannelMessage) -> dict[str, str]:
    return {"role": msg.role, "content": msg.content}


def raise_for_status(response: httpx.Response, *, provider_id: str) -> None:
    if response.status_code >= 400:
        text = response.text[:400] if response.text else "<empty>"
        raise OpenAICompatRequestError(
            status=response.status_code,
            message=f"{provider_id} returned {response.status_code}: {text}",
        )


# ─────────────────────────────────────────────────────────────────────────────
# Adapter base class
# ─────────────────────────────────────────────────────────────────────────────


class OpenAICompatibleProvider:
    """Shared transport for any OpenAI-compatible ``/chat/completions`` endpoint.

    Subclasses MUST set ``id``, ``base_url``, ``context_window_tokens``, and
    ``supports_prompt_cache``. ``supports_streaming`` is True by default since
    every OpenAI-compatible provider in our shortlist streams.
    """

    id: str = "openai-compat"
    base_url: str = ""
    supports_prompt_cache: bool = False
    supports_streaming: bool = True
    context_window_tokens: int = 8_192

    # Auth header style. Override to ``"x-api-key"`` for providers that don't
    # follow the Bearer convention.
    auth_header: str = "authorization"
    auth_value_template: str = "Bearer {key}"

    def __init__(
        self,
        api_key: str,
        *,
        base_url: str | None = None,
        http: httpx.AsyncClient | None = None,
        timeout_s: float = 30.0,
    ) -> None:
        if not api_key:
            raise ValueError(f"{self.id} api_key is required")
        if base_url is not None:
            self.base_url = base_url
        self._api_key = api_key
        self._owns_client = http is None
        self._http = http if http is not None else httpx.AsyncClient(timeout=timeout_s)

    async def aclose(self) -> None:
        if self._owns_client:
            await self._http.aclose()

    # ── completion (non-streaming) ───────────────────────────────────────────

    async def complete(self, req: LLMRequest) -> LLMResponse:
        payload = build_chat_payload(req, stream=False)
        response = await self._http.post(
            f"{self.base_url}/chat/completions",
            headers=self._headers(),
            json=payload,
        )
        raise_for_status(response, provider_id=self.id)
        body = response.json()
        return parse_completion(body, provider_id=self.id, model_fallback=req.model)

    # ── completion (streaming) ───────────────────────────────────────────────

    def stream(self, req: LLMRequest) -> AsyncIterator[LLMStreamChunk]:
        return self._stream(req)

    async def _stream(self, req: LLMRequest) -> AsyncIterator[LLMStreamChunk]:
        payload = build_chat_payload(req, stream=True)
        async with self._http.stream(
            "POST",
            f"{self.base_url}/chat/completions",
            headers=self._headers(),
            json=payload,
        ) as response:
            raise_for_status(response, provider_id=self.id)
            buffer = ""
            usage: LLMUsage | None = None
            async for raw in response.aiter_text():
                buffer += raw
                while True:
                    nl = buffer.find("\n")
                    if nl == -1:
                        break
                    line = buffer[:nl].strip()
                    buffer = buffer[nl + 1 :]
                    if not line.startswith("data:"):
                        continue
                    data = line[len("data:") :].strip()
                    if data == "[DONE]":
                        yield LLMStreamChunk(delta="", done=True, usage=usage)
                        return
                    chunk_obj = json.loads(data)
                    chunk_usage = maybe_usage(chunk_obj)
                    if chunk_usage is not None:
                        usage = chunk_usage
                    delta, finish = parse_stream_chunk(chunk_obj)
                    if delta or finish is not None:
                        yield LLMStreamChunk(
                            delta=delta,
                            done=False,
                            finish_reason=finish,
                            usage=None,
                        )

    # ── reachability probe ───────────────────────────────────────────────────

    async def ping(self) -> dict[str, object]:
        import time

        started = time.perf_counter()
        try:
            await self._http.get(
                f"{self.base_url}/models", headers=self._headers(), timeout=5
            )
            return {"ok": True, "latency_ms": int((time.perf_counter() - started) * 1000)}
        except Exception:
            return {"ok": False, "latency_ms": int((time.perf_counter() - started) * 1000)}

    # ── headers ──────────────────────────────────────────────────────────────

    def _headers(self) -> dict[str, str]:
        return {
            self.auth_header: self.auth_value_template.format(key=self._api_key),
            "content-type": "application/json",
            "accept": "application/json",
        }


# ─────────────────────────────────────────────────────────────────────────────
# Errors
# ─────────────────────────────────────────────────────────────────────────────


class OpenAICompatRequestError(RuntimeError):
    def __init__(self, *, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
