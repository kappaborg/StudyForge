"""OpenAIProvider — wire format verified against a mock transport.

The transport itself is shared with Groq via ``openai_compat`` and is already
covered in ``test_llm_groq.py``. These tests verify that the OpenAI
specialisation sets the right id, base URL, prompt-cache flag, and that the
request lands at ``api.openai.com``.
"""

from __future__ import annotations

import json

import httpx
import pytest

from src.llm.contracts import ChannelMessage, LLMRequest
from src.llm.openai import OPENAI_BASE_URL, OpenAIProvider
from src.llm.openai_compat import OpenAICompatRequestError


def _req() -> LLMRequest:
    return LLMRequest(
        model="gpt-4o-mini",
        messages=[
            ChannelMessage(role="system", content="be brief"),
            ChannelMessage(role="user", content="ping"),
        ],
        max_output_tokens=32,
        temperature=0.0,
        stream=False,
    )


def _client(handler: httpx.MockTransport) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=handler, timeout=5)


def test_openai_provider_has_correct_metadata() -> None:
    p = OpenAIProvider(api_key="sk-test")
    assert p.id == "openai"
    assert p.base_url == OPENAI_BASE_URL
    assert p.supports_prompt_cache is True
    assert p.supports_streaming is True
    assert p.context_window_tokens == 128_000


def test_openai_provider_rejects_empty_api_key() -> None:
    with pytest.raises(ValueError):
        OpenAIProvider(api_key="")


@pytest.mark.asyncio
async def test_openai_provider_completes_against_mock() -> None:
    seen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["auth"] = request.headers.get("authorization")
        seen["body"] = json.loads(request.content)
        return httpx.Response(
            200,
            json={
                "model": "gpt-4o-mini",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": "pong"},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 5, "completion_tokens": 1},
            },
        )

    provider = OpenAIProvider(api_key="sk-test", http=_client(httpx.MockTransport(handler)))
    out = await provider.complete(_req())
    assert out.text == "pong"
    assert out.provider_id == "openai"
    assert out.usage.tokens_in == 5
    assert out.usage.tokens_out == 1
    assert seen["url"] == f"{OPENAI_BASE_URL}/chat/completions"
    assert seen["auth"] == "Bearer sk-test"
    body = seen["body"]
    assert isinstance(body, dict)
    assert body["model"] == "gpt-4o-mini"


@pytest.mark.asyncio
async def test_openai_provider_4xx_raises_typed_error() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"error": {"message": "invalid key"}})

    provider = OpenAIProvider(api_key="sk-test", http=_client(httpx.MockTransport(handler)))
    with pytest.raises(OpenAICompatRequestError) as exc_info:
        await provider.complete(_req())
    assert exc_info.value.status == 401
