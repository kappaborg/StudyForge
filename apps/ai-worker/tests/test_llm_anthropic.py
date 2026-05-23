"""AnthropicProvider — translation tests + mock-transport round-trip.

The wire format differs enough from OpenAI that the translator earns its own
unit tests:
  * ``system`` is a top-level field, not a role in ``messages``
  * Response ``content`` is an array of content blocks
  * Usage uses ``input_tokens`` / ``output_tokens``
  * Stop reasons map to OpenAI-style finish reasons
"""

from __future__ import annotations

import json

import httpx
import pytest

from src.llm.anthropic import (
    ANTHROPIC_BASE_URL,
    ANTHROPIC_VERSION,
    AnthropicProvider,
    AnthropicRequestError,
    _concat_text_blocks,
    _normalise_stop_reason,
    build_messages_payload,
    parse_messages_response,
)
from src.llm.contracts import ChannelMessage, LLMRequest


def _req(**overrides: object) -> LLMRequest:
    base = {
        "model": "claude-haiku-4-5-20251001",
        "messages": [
            ChannelMessage(role="system", content="be brief"),
            ChannelMessage(role="user", content="ping"),
        ],
        "max_output_tokens": 64,
        "temperature": 0.0,
        "stream": False,
    }
    base.update(overrides)
    return LLMRequest.model_validate(base)


def _client(handler: httpx.MockTransport) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=handler, timeout=5)


# ── pure translator units ───────────────────────────────────────────────────


def test_payload_promotes_system_to_top_level() -> None:
    payload = build_messages_payload(_req(), stream=False)
    assert "system" in payload
    assert payload["system"] == "be brief"
    # System messages must NOT appear inside `messages`.
    roles = [m["role"] for m in payload["messages"]]
    assert "system" not in roles


def test_payload_collapses_multiple_system_messages() -> None:
    req = LLMRequest(
        model="claude-test",
        messages=[
            ChannelMessage(role="system", content="rule 1"),
            ChannelMessage(role="system", content="rule 2"),
            ChannelMessage(role="user", content="q"),
        ],
        max_output_tokens=16,
        temperature=0.0,
        stream=False,
    )
    payload = build_messages_payload(req, stream=False)
    assert payload["system"] == "rule 1\n\nrule 2"


def test_payload_strips_tool_messages() -> None:
    req = LLMRequest(
        model="claude-test",
        messages=[
            ChannelMessage(role="user", content="q"),
            ChannelMessage(role="tool", content="should be stripped"),
            ChannelMessage(role="assistant", content="a"),
        ],
        max_output_tokens=16,
        temperature=0.0,
        stream=False,
    )
    payload = build_messages_payload(req, stream=False)
    contents = [m["content"] for m in payload["messages"]]
    assert "should be stripped" not in contents


def test_payload_marks_cache_prefix_when_boundary_set() -> None:
    req = LLMRequest(
        model="claude-test",
        messages=[
            ChannelMessage(role="system", content="long course context …"),
            ChannelMessage(role="user", content="question"),
        ],
        max_output_tokens=16,
        temperature=0.0,
        stream=False,
        cache_prefix_boundary=1,
    )
    payload = build_messages_payload(req, stream=False)
    system = payload["system"]
    assert isinstance(system, list)
    assert system[0]["cache_control"] == {"type": "ephemeral"}


def test_payload_passes_stop_sequences_and_metadata_user() -> None:
    payload = build_messages_payload(
        _req(stop=["END"], user="user-42"), stream=False
    )
    assert payload["stop_sequences"] == ["END"]
    assert payload["metadata"] == {"user_id": "user-42"}


def test_concat_text_blocks_ignores_non_text_blocks() -> None:
    blocks = [
        {"type": "text", "text": "Hello "},
        {"type": "tool_use", "id": "t1"},
        {"type": "text", "text": "world."},
    ]
    assert _concat_text_blocks(blocks) == "Hello world."


def test_normalise_stop_reason_maps_anthropic_to_openai_finish() -> None:
    assert _normalise_stop_reason("end_turn") == "stop"
    assert _normalise_stop_reason("max_tokens") == "length"
    assert _normalise_stop_reason("tool_use") == "tool_calls"
    assert _normalise_stop_reason("unknown") == "unknown"


def test_parse_messages_response_extracts_text_usage_and_cache() -> None:
    body = {
        "model": "claude-haiku-4-5-20251001",
        "content": [{"type": "text", "text": "pong"}],
        "stop_reason": "end_turn",
        "usage": {
            "input_tokens": 50,
            "output_tokens": 2,
            "cache_read_input_tokens": 45,
        },
    }
    resp = parse_messages_response(body, model_fallback="x")
    assert resp.text == "pong"
    assert resp.finish_reason == "stop"
    assert resp.provider_id == "anthropic"
    assert resp.usage.tokens_in == 50
    assert resp.usage.tokens_out == 2
    assert resp.usage.cache_hit is True


# ── HTTP via MockTransport ───────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_anthropic_complete_against_mock() -> None:
    seen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["api_key"] = request.headers.get("x-api-key")
        seen["version"] = request.headers.get("anthropic-version")
        seen["body"] = json.loads(request.content)
        return httpx.Response(
            200,
            json={
                "model": "claude-haiku-4-5-20251001",
                "content": [{"type": "text", "text": "Hi from Claude."}],
                "stop_reason": "end_turn",
                "usage": {"input_tokens": 12, "output_tokens": 5},
            },
        )

    provider = AnthropicProvider(
        api_key="sk-ant-test", http=_client(httpx.MockTransport(handler))
    )
    out = await provider.complete(_req())
    assert out.text == "Hi from Claude."
    assert out.usage.tokens_in == 12
    assert out.usage.tokens_out == 5
    assert out.finish_reason == "stop"
    assert seen["url"] == f"{ANTHROPIC_BASE_URL}/messages"
    assert seen["api_key"] == "sk-ant-test"
    assert seen["version"] == ANTHROPIC_VERSION


@pytest.mark.asyncio
async def test_anthropic_4xx_raises_typed_error() -> None:
    def handler(_req: httpx.Request) -> httpx.Response:
        return httpx.Response(429, json={"error": {"message": "rate limited"}})

    provider = AnthropicProvider(
        api_key="sk-ant-test", http=_client(httpx.MockTransport(handler))
    )
    with pytest.raises(AnthropicRequestError) as exc_info:
        await provider.complete(_req())
    assert exc_info.value.status == 429


def test_anthropic_rejects_empty_api_key() -> None:
    with pytest.raises(ValueError):
        AnthropicProvider(api_key="")


@pytest.mark.asyncio
async def test_anthropic_stream_not_yet_implemented() -> None:
    provider = AnthropicProvider(api_key="sk-ant-test")
    with pytest.raises(NotImplementedError):
        async for _chunk in provider.stream(_req(stream=True)):
            pass
