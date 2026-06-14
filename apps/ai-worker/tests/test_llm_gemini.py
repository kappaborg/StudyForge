"""GeminiProvider — Google AI Studio adapter (non-OpenAI shape).

These tests exercise the pure translation helpers without hitting the
network. The adapter class itself is covered by registry tests; what
matters here is that the wire format is faithful to Google's
``generateContent`` spec, that cache hits are surfaced, and that role
translation handles the user/model rename.
"""

from __future__ import annotations

import httpx
import pytest

from src.llm.contracts import ChannelMessage, LLMRequest, LLMUsage
from src.llm.gemini import (
    GeminiProvider,
    GeminiRequestError,
    build_gemini_payload,
    parse_gemini_response,
    parse_gemini_stream_chunk,
)

# ─────────────────────────────────────────────────────────────────────────────
# build_gemini_payload — provider-agnostic LLMRequest → Gemini wire format
# ─────────────────────────────────────────────────────────────────────────────


def _req(messages: list[ChannelMessage], **overrides: object) -> LLMRequest:
    return LLMRequest(
        model="gemini-2.0-flash",
        messages=messages,
        max_output_tokens=256,
        temperature=0.3,
        **overrides,  # type: ignore[arg-type]
    )


def test_system_messages_become_top_level_system_instruction() -> None:
    req = _req(
        [
            ChannelMessage(role="system", content="You are a helpful tutor."),
            ChannelMessage(role="user", content="What is RAG?"),
        ]
    )
    body = build_gemini_payload(req)
    assert body["systemInstruction"] == {
        "parts": [{"text": "You are a helpful tutor."}]
    }
    # System message must not leak into contents.
    assert all(c["role"] != "system" for c in body["contents"])


def test_multiple_system_messages_are_joined_with_blank_line() -> None:
    req = _req(
        [
            ChannelMessage(role="system", content="A"),
            ChannelMessage(role="system", content="B"),
            ChannelMessage(role="user", content="Q"),
        ]
    )
    body = build_gemini_payload(req)
    assert body["systemInstruction"]["parts"][0]["text"] == "A\n\nB"


def test_assistant_role_translates_to_gemini_model_role() -> None:
    req = _req(
        [
            ChannelMessage(role="user", content="hi"),
            ChannelMessage(role="assistant", content="hi back"),
            ChannelMessage(role="user", content="bye"),
        ]
    )
    body = build_gemini_payload(req)
    assert [c["role"] for c in body["contents"]] == ["user", "model", "user"]


def test_tool_messages_are_stripped() -> None:
    req = _req(
        [
            ChannelMessage(role="user", content="hi"),
            ChannelMessage(role="tool", content="tool result"),
            ChannelMessage(role="user", content="ok"),
        ]
    )
    body = build_gemini_payload(req)
    assert len(body["contents"]) == 2
    assert all("tool" not in c.get("parts", [{}])[0].get("text", "") for c in body["contents"])


def test_generation_config_carries_temperature_and_max_tokens() -> None:
    req = _req([ChannelMessage(role="user", content="hi")])
    body = build_gemini_payload(req)
    assert body["generationConfig"]["temperature"] == 0.3
    assert body["generationConfig"]["maxOutputTokens"] == 256


def test_stop_sequences_passthrough() -> None:
    req = _req([ChannelMessage(role="user", content="hi")], stop=["END", "STOP"])
    body = build_gemini_payload(req)
    assert body["generationConfig"]["stopSequences"] == ["END", "STOP"]


# ─────────────────────────────────────────────────────────────────────────────
# parse_gemini_response — Gemini wire format → LLMResponse
# ─────────────────────────────────────────────────────────────────────────────


def test_response_extracts_text_from_first_candidate() -> None:
    body = {
        "candidates": [
            {
                "content": {"parts": [{"text": "Hello, world."}], "role": "model"},
                "finishReason": "STOP",
            }
        ],
        "usageMetadata": {
            "promptTokenCount": 10,
            "candidatesTokenCount": 5,
        },
        "modelVersion": "gemini-2.0-flash-001",
    }
    res = parse_gemini_response(body, model_fallback="gemini-2.0-flash")
    assert res.text == "Hello, world."
    assert res.finish_reason == "stop"
    assert res.model == "gemini-2.0-flash-001"
    assert res.provider_id == "gemini"
    assert res.usage.tokens_in == 10
    assert res.usage.tokens_out == 5


def test_response_concatenates_multipart_text() -> None:
    body = {
        "candidates": [
            {
                "content": {
                    "parts": [{"text": "Hello, "}, {"text": "world."}],
                    "role": "model",
                },
                "finishReason": "STOP",
            }
        ],
    }
    res = parse_gemini_response(body, model_fallback="gemini-2.0-flash")
    assert res.text == "Hello, world."


def test_response_normalises_finish_reasons() -> None:
    cases = [
        ("STOP", "stop"),
        ("MAX_TOKENS", "length"),
        ("SAFETY", "content_filter"),
        ("RECITATION", "content_filter"),
        ("OTHER", "stop"),
    ]
    for raw, normalised in cases:
        body = {
            "candidates": [{"content": {"parts": [{"text": "x"}]}, "finishReason": raw}]
        }
        res = parse_gemini_response(body, model_fallback="m")
        assert res.finish_reason == normalised, f"{raw} → expected {normalised}"


def test_response_raises_on_empty_candidates() -> None:
    with pytest.raises(GeminiRequestError):
        parse_gemini_response({"candidates": []}, model_fallback="m")


def test_response_falls_back_to_model_fallback_when_model_version_missing() -> None:
    body = {
        "candidates": [{"content": {"parts": [{"text": "x"}]}, "finishReason": "STOP"}]
    }
    res = parse_gemini_response(body, model_fallback="gemini-1.5-pro")
    assert res.model == "gemini-1.5-pro"


# ─────────────────────────────────────────────────────────────────────────────
# Cache-hit surfacing — Gemini context caching (cachedContents)
# ─────────────────────────────────────────────────────────────────────────────


def test_cached_content_tokens_propagate_to_llm_usage() -> None:
    body = {
        "candidates": [
            {"content": {"parts": [{"text": "ok"}]}, "finishReason": "STOP"}
        ],
        "usageMetadata": {
            "promptTokenCount": 100,
            "candidatesTokenCount": 20,
            "cachedContentTokenCount": 80,
        },
    }
    res = parse_gemini_response(body, model_fallback="m")
    assert res.usage.cached_tokens_in == 80
    assert res.usage.cache_hit is True
    assert res.usage.cache_hit_ratio == 0.8


def test_zero_cached_tokens_means_no_cache_hit() -> None:
    body = {
        "candidates": [
            {"content": {"parts": [{"text": "ok"}]}, "finishReason": "STOP"}
        ],
        "usageMetadata": {"promptTokenCount": 50, "candidatesTokenCount": 10},
    }
    res = parse_gemini_response(body, model_fallback="m")
    assert res.usage.cached_tokens_in == 0
    assert res.usage.cache_hit is False


# ─────────────────────────────────────────────────────────────────────────────
# parse_gemini_stream_chunk — SSE delta parsing
# ─────────────────────────────────────────────────────────────────────────────


def test_stream_chunk_returns_partial_text_no_finish() -> None:
    obj = {
        "candidates": [{"content": {"parts": [{"text": "Hel"}], "role": "model"}}]
    }
    delta, finish = parse_gemini_stream_chunk(obj)
    assert delta == "Hel"
    assert finish is None


def test_stream_chunk_returns_finish_on_terminal_event() -> None:
    obj = {
        "candidates": [
            {
                "content": {"parts": [{"text": "lo."}], "role": "model"},
                "finishReason": "STOP",
            }
        ]
    }
    delta, finish = parse_gemini_stream_chunk(obj)
    assert delta == "lo."
    assert finish == "stop"


def test_stream_chunk_handles_missing_candidates_gracefully() -> None:
    delta, finish = parse_gemini_stream_chunk({})
    assert delta == ""
    assert finish is None


# ─────────────────────────────────────────────────────────────────────────────
# Adapter wiring — http client + auth
# ─────────────────────────────────────────────────────────────────────────────


def test_provider_requires_api_key() -> None:
    with pytest.raises(ValueError, match="api_key is required"):
        GeminiProvider(api_key="")


def test_provider_identity_flags() -> None:
    p = GeminiProvider(api_key="x")
    assert p.id == "gemini"
    assert p.supports_prompt_cache is True
    assert p.supports_streaming is True
    assert p.context_window_tokens == 1_048_576


@pytest.mark.asyncio
async def test_provider_aclose_is_safe() -> None:
    p = GeminiProvider(api_key="x")
    await p.aclose()


@pytest.mark.asyncio
async def test_complete_uses_header_auth_not_query_param() -> None:
    """The Gemini API key MUST go in the ``x-goog-api-key`` header, NOT
    the URL query string. URL query params leak the key into HTTP access
    logs, CDN logs, browser devtools, and Sentry breadcrumbs that capture
    the request URL. This test guards against a regression where someone
    "fixes" the auth to use ``?key=`` again."""

    captured: dict[str, object] = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["auth_header"] = request.headers.get("authorization")
        captured["api_key_header"] = request.headers.get("x-api-key")
        captured["goog_api_key_header"] = request.headers.get("x-goog-api-key")
        return httpx.Response(
            200,
            json={
                "candidates": [
                    {
                        "content": {"parts": [{"text": "ok"}], "role": "model"},
                        "finishReason": "STOP",
                    }
                ],
                "usageMetadata": {"promptTokenCount": 1, "candidatesTokenCount": 1},
            },
        )

    transport = httpx.MockTransport(handler)
    client = httpx.AsyncClient(transport=transport)
    p = GeminiProvider(api_key="my-secret-key", http=client)
    res = await p.complete(
        LLMRequest(
            model="gemini-2.0-flash",
            messages=[ChannelMessage(role="user", content="hi")],
        )
    )

    assert res.text == "ok"
    # The key must NOT appear anywhere in the URL.
    assert "my-secret-key" not in str(captured["url"])
    assert "key=" not in str(captured["url"])
    # The key MUST appear in the ``x-goog-api-key`` header.
    assert captured["goog_api_key_header"] == "my-secret-key"
    # And it must NOT leak into other auth headers.
    assert captured["auth_header"] is None
    assert captured["api_key_header"] is None


@pytest.mark.asyncio
async def test_complete_raises_gemini_request_error_on_4xx() -> None:
    async def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(429, text='{"error":"rate limited"}')

    transport = httpx.MockTransport(handler)
    client = httpx.AsyncClient(transport=transport)
    p = GeminiProvider(api_key="x", http=client)
    with pytest.raises(GeminiRequestError) as exc:
        await p.complete(
            LLMRequest(
                model="gemini-2.0-flash",
                messages=[ChannelMessage(role="user", content="hi")],
            )
        )
    assert exc.value.status == 429


def test_llm_usage_cache_hit_ratio_is_zero_when_no_input_tokens() -> None:
    # Boundary case: zero prompt tokens shouldn't divide by zero in
    # cache_hit_ratio. This is a contracts-level assertion but we keep
    # it in the Gemini suite because it's the cache-aware adapter.
    u = LLMUsage(tokens_in=0, tokens_out=10, cached_tokens_in=0)
    assert u.cache_hit_ratio == 0.0
