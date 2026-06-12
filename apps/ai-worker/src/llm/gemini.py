"""Gemini provider adapter.

Google's ``generativelanguage.googleapis.com`` doesn't follow the OpenAI
shape:
  * Auth is via ``?key=`` query param, not a header
  * Roles are ``user`` / ``model`` (no ``assistant``, no ``system``)
  * ``system`` content lives in a top-level ``systemInstruction`` block
  * Request body is ``contents: [{role, parts: [{text}]}]``
  * Response is ``candidates[0].content.parts[].text`` + finishReason
  * Usage block uses camelCase keys (``promptTokenCount`` etc.)
  * Token cache hits land in ``cachedContentTokenCount`` — but the actual
    cache reference (``cachedContent: "cachedContents/...""``) is set by
    the caller after a separate ``cachedContents`` resource create.
    Phase B-2 surfaces the flag; the create-then-reference flow is a
    Phase B-3 follow-up.

Gemini's free tier (Gemini 2.0 Flash via AI Studio) is the most generous
of any free LLM provider — 60 RPM, 1500 RPD. It's the §13.1 second-line
free provider after Groq.
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

GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"


class GeminiProvider:
    id: str = "gemini"
    supports_prompt_cache: bool = True
    supports_streaming: bool = True
    context_window_tokens: int = 1_048_576  # Gemini 2.0 Flash 1M context

    def __init__(
        self,
        api_key: str,
        *,
        base_url: str = GEMINI_BASE_URL,
        http: httpx.AsyncClient | None = None,
        timeout_s: float = 30.0,
    ) -> None:
        if not api_key:
            raise ValueError("gemini api_key is required")
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._owns_client = http is None
        self._http = http if http is not None else httpx.AsyncClient(timeout=timeout_s)

    async def aclose(self) -> None:
        if self._owns_client:
            await self._http.aclose()

    async def complete(self, req: LLMRequest) -> LLMResponse:
        payload = build_gemini_payload(req)
        url = f"{self._base_url}/models/{req.model}:generateContent?key={self._api_key}"
        response = await self._http.post(url, json=payload, headers=self._headers())
        raise_for_status(response)
        body = response.json()
        return parse_gemini_response(body, model_fallback=req.model)

    def stream(self, req: LLMRequest) -> AsyncIterator[LLMStreamChunk]:
        return self._stream(req)

    async def _stream(self, req: LLMRequest) -> AsyncIterator[LLMStreamChunk]:
        payload = build_gemini_payload(req)
        url = (
            f"{self._base_url}/models/{req.model}:streamGenerateContent"
            f"?alt=sse&key={self._api_key}"
        )
        async with self._http.stream(
            "POST", url, json=payload, headers=self._headers()
        ) as response:
            raise_for_status(response)
            buffer = ""
            last_usage: LLMUsage | None = None
            final_finish: str | None = None
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
                    if not data:
                        continue
                    obj = json.loads(data)
                    delta, finish = parse_gemini_stream_chunk(obj)
                    chunk_usage = _extract_usage(obj)
                    if chunk_usage is not None:
                        last_usage = chunk_usage
                    if finish is not None:
                        final_finish = finish
                    if delta or finish is not None:
                        yield LLMStreamChunk(
                            delta=delta,
                            done=False,
                            finish_reason=finish,
                            usage=None,
                        )
            yield LLMStreamChunk(
                delta="",
                done=True,
                finish_reason=final_finish,
                usage=last_usage,
            )

    async def ping(self) -> dict[str, object]:
        import time

        started = time.perf_counter()
        try:
            await self._http.get(
                f"{self._base_url}/models?key={self._api_key}",
                headers=self._headers(),
                timeout=5,
            )
            return {"ok": True, "latency_ms": int((time.perf_counter() - started) * 1000)}
        except Exception:
            return {"ok": False, "latency_ms": int((time.perf_counter() - started) * 1000)}

    def _headers(self) -> dict[str, str]:
        return {"content-type": "application/json", "accept": "application/json"}


# ─────────────────────────────────────────────────────────────────────────────
# Pure helpers — payload + response translators, exported for unit tests
# ─────────────────────────────────────────────────────────────────────────────


def build_gemini_payload(req: LLMRequest) -> dict[str, Any]:
    """Translate the provider-agnostic ``LLMRequest`` into Gemini's
    ``generateContent`` body shape.

    * Collapses any ``system`` messages into the top-level
      ``systemInstruction`` field.
    * Maps ``assistant`` → ``model`` to satisfy Gemini's role vocabulary.
    * Strips ``tool`` messages (Gemini's function-calling shape is wired
      separately).
    """
    system_parts: list[str] = []
    contents: list[dict[str, Any]] = []
    for msg in req.messages:
        if msg.role == "system":
            system_parts.append(msg.content)
            continue
        if msg.role == "tool":
            continue
        role = "model" if msg.role == "assistant" else "user"
        contents.append({"role": role, "parts": [{"text": msg.content}]})

    body: dict[str, Any] = {
        "contents": contents,
        "generationConfig": {
            "temperature": req.temperature,
            "maxOutputTokens": req.max_output_tokens,
        },
    }
    if system_parts:
        body["systemInstruction"] = {"parts": [{"text": "\n\n".join(system_parts)}]}
    if req.stop is not None:
        body["generationConfig"]["stopSequences"] = req.stop
    return body


def parse_gemini_response(body: dict[str, Any], *, model_fallback: str) -> LLMResponse:
    candidates = body.get("candidates") or []
    if not candidates:
        raise GeminiRequestError(
            status=500, message="gemini response missing candidates"
        )
    candidate = candidates[0]
    text = _concat_parts(candidate.get("content", {}).get("parts") or [])
    finish = _normalise_finish_reason(str(candidate.get("finishReason") or "STOP"))
    return LLMResponse(
        text=text,
        finish_reason=finish,
        usage=_extract_usage(body) or LLMUsage(),
        model=str(body.get("modelVersion") or model_fallback),
        provider_id="gemini",
    )


def parse_gemini_stream_chunk(obj: dict[str, Any]) -> tuple[str, str | None]:
    candidates = obj.get("candidates") or []
    if not candidates:
        return "", None
    candidate = candidates[0]
    text = _concat_parts(candidate.get("content", {}).get("parts") or [])
    finish_raw = candidate.get("finishReason")
    finish = (
        _normalise_finish_reason(str(finish_raw)) if isinstance(finish_raw, str) else None
    )
    return text, finish


def _concat_parts(parts: list[Any]) -> str:
    out: list[str] = []
    for part in parts:
        if isinstance(part, dict) and "text" in part:
            out.append(str(part["text"]))
    return "".join(out)


def _normalise_finish_reason(raw: str) -> str:
    # Gemini uses UPPERCASE enums. Map to the OpenAI-style strings used
    # everywhere else in the platform.
    mapping = {
        "STOP": "stop",
        "MAX_TOKENS": "length",
        "SAFETY": "content_filter",
        "RECITATION": "content_filter",
        "OTHER": "stop",
    }
    return mapping.get(raw, raw.lower())


def _extract_usage(body: dict[str, Any]) -> LLMUsage | None:
    usage = body.get("usageMetadata")
    if not isinstance(usage, dict):
        return None
    cached = int(usage.get("cachedContentTokenCount", 0) or 0)
    return LLMUsage(
        tokens_in=int(usage.get("promptTokenCount", 0) or 0),
        tokens_out=int(usage.get("candidatesTokenCount", 0) or 0),
        cached_tokens_in=cached,
        cache_hit=cached > 0,
    )


def raise_for_status(response: httpx.Response) -> None:
    if response.status_code >= 400:
        text = response.text[:400] if response.text else "<empty>"
        raise GeminiRequestError(
            status=response.status_code,
            message=f"Gemini returned {response.status_code}: {text}",
        )


class GeminiRequestError(RuntimeError):
    def __init__(self, *, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


__all__ = [
    "GEMINI_BASE_URL",
    "ChannelMessage",
    "GeminiProvider",
    "GeminiRequestError",
    "LLMStreamChunk",
    "build_gemini_payload",
    "parse_gemini_response",
    "parse_gemini_stream_chunk",
]
