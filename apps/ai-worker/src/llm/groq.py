"""Groq provider adapter.

Thin specialisation of ``OpenAICompatibleProvider``. Groq exposes the same
``/chat/completions`` shape as OpenAI at ``api.groq.com/openai/v1``; the
transport lives in ``openai_compat`` so the OpenAI, OpenRouter, Together,
and Fireworks adapters share the same implementation.
"""

from __future__ import annotations

from .openai_compat import (
    OpenAICompatRequestError,
    OpenAICompatibleProvider,
    build_chat_payload,
    extract_usage,
    parse_completion,
    parse_stream_chunk,
)

GROQ_BASE_URL = "https://api.groq.com/openai/v1"


class GroqProvider(OpenAICompatibleProvider):
    id: str = "groq"
    base_url: str = GROQ_BASE_URL
    supports_prompt_cache: bool = False
    supports_streaming: bool = True
    context_window_tokens: int = 32_768  # Llama 3.3 70B context window


# ─────────────────────────────────────────────────────────────────────────────
# Backward-compatibility shims — the original Phase-1 tests import these by
# private name. Re-export from openai_compat so existing tests stay green.
# ─────────────────────────────────────────────────────────────────────────────


def _build_payload(req, *, stream):  # type: ignore[no-untyped-def]
    return build_chat_payload(req, stream=stream)


def _parse_completion(body, *, model_fallback):  # type: ignore[no-untyped-def]
    return parse_completion(body, provider_id="groq", model_fallback=model_fallback)


def _extract_usage(body):  # type: ignore[no-untyped-def]
    return extract_usage(body)


def _parse_stream_chunk(obj):  # type: ignore[no-untyped-def]
    return parse_stream_chunk(obj)


def _to_openai_message(msg):  # type: ignore[no-untyped-def]
    return {"role": msg.role, "content": msg.content}


# Alias the error type for callers still using ``GroqRequestError``.
GroqRequestError = OpenAICompatRequestError


__all__ = [
    "GROQ_BASE_URL",
    "GroqProvider",
    "GroqRequestError",
]
