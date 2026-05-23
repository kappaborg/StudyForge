"""GroqProvider — pure functions verified directly; HTTP verified via mock transport."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator

import httpx
import pytest

from src.llm.contracts import ChannelMessage, LLMRequest, LLMUsage
from src.llm.groq import (
    GroqProvider,
    GroqRequestError,
    _build_payload,
    _extract_usage,
    _parse_completion,
    _parse_stream_chunk,
    _to_openai_message,
)


def _req(**overrides: object) -> LLMRequest:
    base = {
        "model": "llama-3.3-70b-versatile",
        "messages": [
            ChannelMessage(role="system", content="be helpful"),
            ChannelMessage(role="user", content="say hi"),
        ],
        "max_output_tokens": 64,
        "temperature": 0.1,
        "stream": False,
    }
    base.update(overrides)
    return LLMRequest.model_validate(base)


# ── pure-function units ──────────────────────────────────────────────────────


def test_payload_includes_required_openai_fields() -> None:
    payload = _build_payload(_req(stop=["END"], user="user-42"), stream=False)
    assert payload["model"] == "llama-3.3-70b-versatile"
    assert payload["temperature"] == 0.1
    assert payload["max_tokens"] == 64
    assert payload["stream"] is False
    assert payload["stop"] == ["END"]
    assert payload["user"] == "user-42"
    assert "stream_options" not in payload


def test_stream_payload_requests_usage_block() -> None:
    payload = _build_payload(_req(), stream=True)
    assert payload["stream"] is True
    assert payload["stream_options"] == {"include_usage": True}


def test_channel_message_translation_preserves_roles() -> None:
    msg = ChannelMessage(role="assistant", content="prior turn")
    assert _to_openai_message(msg) == {"role": "assistant", "content": "prior turn"}


def test_parse_completion_extracts_text_finish_usage() -> None:
    body = {
        "model": "llama-3.3-70b-versatile",
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": "hello"},
                "finish_reason": "stop",
            }
        ],
        "usage": {"prompt_tokens": 18, "completion_tokens": 2, "total_tokens": 20},
    }
    resp = _parse_completion(body, model_fallback="llama-3.3-70b-versatile")
    assert resp.text == "hello"
    assert resp.finish_reason == "stop"
    assert resp.usage.tokens_in == 18
    assert resp.usage.tokens_out == 2
    assert resp.provider_id == "groq"


def test_parse_completion_raises_on_missing_choices() -> None:
    with pytest.raises(GroqRequestError):
        _parse_completion({"choices": []}, model_fallback="x")


def test_extract_usage_is_zero_safe() -> None:
    usage = _extract_usage({})
    assert usage == LLMUsage(tokens_in=0, tokens_out=0, cache_hit=False)


def test_parse_stream_chunk_returns_delta_and_finish() -> None:
    chunk = {
        "choices": [
            {"delta": {"content": "Hello"}, "finish_reason": None},
        ]
    }
    delta, finish = _parse_stream_chunk(chunk)
    assert delta == "Hello"
    assert finish is None

    terminal = {"choices": [{"delta": {}, "finish_reason": "stop"}]}
    delta, finish = _parse_stream_chunk(terminal)
    assert delta == ""
    assert finish == "stop"


# ── HTTP via MockTransport ───────────────────────────────────────────────────


def _client_with(handler: httpx.MockTransport) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=handler, timeout=5)


@pytest.mark.asyncio
async def test_complete_round_trip_against_mock() -> None:
    seen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["auth"] = request.headers.get("authorization")
        seen["body"] = json.loads(request.content)
        return httpx.Response(
            200,
            json={
                "model": "llama-3.3-70b-versatile",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": "Hi there!"},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 12, "completion_tokens": 3},
            },
        )

    transport = httpx.MockTransport(handler)
    provider = GroqProvider(api_key="test-key", http=_client_with(transport))
    out = await provider.complete(_req())
    assert out.text == "Hi there!"
    assert out.provider_id == "groq"
    assert out.usage.tokens_in == 12
    assert out.usage.tokens_out == 3
    assert seen["url"] == "https://api.groq.com/openai/v1/chat/completions"
    assert seen["auth"] == "Bearer test-key"


@pytest.mark.asyncio
async def test_complete_maps_4xx_to_typed_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            429,
            json={"error": {"message": "rate limited"}},
        )

    provider = GroqProvider(api_key="test-key", http=_client_with(httpx.MockTransport(handler)))
    with pytest.raises(GroqRequestError) as exc_info:
        await provider.complete(_req())
    assert exc_info.value.status == 429


@pytest.mark.asyncio
async def test_stream_emits_delta_chunks_then_usage_on_done() -> None:
    sse_body = (
        b'data: {"choices":[{"delta":{"content":"Hel"},"finish_reason":null}]}\n'
        b'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":null}]}\n'
        b'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n'
        b'data: {"usage":{"prompt_tokens":7,"completion_tokens":2}}\n'
        b"data: [DONE]\n"
    )

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            content=sse_body,
            headers={"content-type": "text/event-stream"},
        )

    provider = GroqProvider(api_key="test-key", http=_client_with(httpx.MockTransport(handler)))

    chunks: list[str] = []
    finish: str | None = None
    usage_seen: LLMUsage | None = None
    stream: AsyncIterator = provider.stream(_req(stream=True))
    async for chunk in stream:
        if chunk.delta:
            chunks.append(chunk.delta)
        if chunk.finish_reason is not None:
            finish = chunk.finish_reason
        if chunk.done:
            usage_seen = chunk.usage

    assert "".join(chunks) == "Hello"
    assert finish == "stop"
    assert usage_seen is not None
    assert usage_seen.tokens_in == 7
    assert usage_seen.tokens_out == 2


def test_constructor_rejects_empty_api_key() -> None:
    with pytest.raises(ValueError):
        GroqProvider(api_key="")
