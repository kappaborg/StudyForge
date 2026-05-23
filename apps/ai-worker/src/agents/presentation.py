"""Presentation generator agent (Phase 3 #6, stretch).

Emits a Markdown deck. Each slide is separated by ``---`` on its own
line; titles use H1/H2. The FE parses this into a slide carousel; users
can also copy the raw markdown into reveal.js / Slidev.
"""

from __future__ import annotations

import logging
import re
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from ..llm.contracts import (
    ChannelMessage as LLMChannelMessage,
    LLMProvider,
    LLMRequest,
)
from ..safety.prompt_builder import build_messages
from .contracts import RetrievedChunk

log = logging.getLogger(__name__)

DEFAULT_MODEL = "llama-3.1-8b-instant"

PRESENTATION_SYSTEM_PROMPT = (
    "You are StudyForge, drafting a study presentation from a student's "
    "uploaded materials.\n\n"
    "OUTPUT FORMAT — STRICT:\n"
    "- Output Markdown. Each slide is one section. Slides are separated by "
    "a line containing only ``---`` (three dashes).\n"
    "- First slide: ``# {title}`` plus a short subtitle line.\n"
    "- Subsequent slides: ``## {slide title}`` followed by 3–6 bullet "
    "points (``- bullet``).\n"
    "- The last slide is a ``## Summary`` with the three biggest takeaways.\n"
    "- 6–10 slides total. Pull content from the supplied "
    "<untrusted_document> blocks; do not invent facts.\n"
    "- No markdown fences around the document, no commentary."
)


class PresentationFromChunksInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    course_id: str
    tenant_id: str
    user_id: str
    query: str = ""
    slide_count: int = Field(default=8, ge=4, le=20)


class PresentationOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    course_id: str
    title: str
    markdown: str
    slide_count: int


_TITLE_RE = re.compile(r"^#\s+(.+)$", flags=re.MULTILINE)


class PresentationAgent:
    name = "presentation.generate.v1"
    version = "0.1.0"
    input_model = PresentationFromChunksInput
    output_model = PresentationOutput

    def __init__(
        self,
        provider: LLMProvider | None = None,
        *,
        model: str = DEFAULT_MODEL,
        max_output_tokens: int = 1536,
        temperature: float = 0.3,
    ) -> None:
        self._provider = provider
        self._model = model
        self._max_output_tokens = max_output_tokens
        self._temperature = temperature

    async def run(
        self,
        payload: PresentationFromChunksInput,
        retrieved_chunks: list[RetrievedChunk],
    ) -> PresentationOutput:
        if not retrieved_chunks:
            return PresentationOutput(
                course_id=payload.course_id,
                title=self._title(payload),
                markdown=self._stub_markdown(payload, []),
                slide_count=0,
            )
        if self._provider is None:
            md = self._stub_markdown(payload, retrieved_chunks)
            return PresentationOutput(
                course_id=payload.course_id,
                title=self._title(payload),
                markdown=md,
                slide_count=_count_slides(md),
            )

        try:
            response = await self._call_llm(payload, retrieved_chunks)
        except Exception as exc:  # noqa: BLE001
            log.warning("presentation.llm_error fallback_to_stub err=%s", exc)
            md = self._stub_markdown(payload, retrieved_chunks)
            return PresentationOutput(
                course_id=payload.course_id,
                title=self._title(payload),
                markdown=md,
                slide_count=_count_slides(md),
            )

        markdown = response.text.strip()
        # Quick sanity: at least one slide separator. Otherwise fall back.
        if "---" not in markdown:
            log.warning("presentation.no_separators preview=%r", markdown[:200])
            markdown = self._stub_markdown(payload, retrieved_chunks)

        title_match = _TITLE_RE.search(markdown)
        title = title_match.group(1).strip() if title_match else self._title(payload)
        return PresentationOutput(
            course_id=payload.course_id,
            title=title,
            markdown=markdown,
            slide_count=_count_slides(markdown),
        )

    async def _call_llm(
        self,
        payload: PresentationFromChunksInput,
        chunks: list[RetrievedChunk],
    ) -> Any:
        assert self._provider is not None
        seed = payload.query or "Draft a study presentation covering the materials end-to-end."
        seed_with_count = f"{seed}\n\nProduce exactly {payload.slide_count} slides."
        messages = build_messages(
            system_prompt=PRESENTATION_SYSTEM_PROMPT,
            user_query=seed_with_count,
            retrieved_chunks=chunks,
        )
        llm_messages = [LLMChannelMessage(role=m.role, content=m.content) for m in messages]
        return await self._provider.complete(
            LLMRequest(
                model=self._model,
                messages=llm_messages,
                max_output_tokens=self._max_output_tokens,
                temperature=self._temperature,
                stream=False,
                user=payload.user_id,
                cache_prefix_boundary=1,
            )
        )

    def _stub_markdown(
        self,
        payload: PresentationFromChunksInput,
        chunks: list[RetrievedChunk],
    ) -> str:
        title = self._title(payload)
        sections: list[str] = [f"# {title}\n\nA quick tour of your materials."]
        for chunk in chunks[: payload.slide_count - 1]:
            snippet = " ".join(chunk.content.split())
            heading = snippet[:60] or "Passage"
            bullets = self._bullets_from(snippet)
            body = "\n".join(f"- {b}" for b in bullets)
            sections.append(f"## {heading}\n\n{body}")
        sections.append(
            "## Summary\n\n- Multiple sub-topics covered above.\n"
            "- Drill in with the Tutor tab.\n- Take a quiz to test recall."
        )
        return "\n\n---\n\n".join(sections)

    @staticmethod
    def _bullets_from(snippet: str) -> list[str]:
        sentences = [s.strip() for s in re.split(r"(?<=[.!?])\s+", snippet) if s.strip()]
        return sentences[:5] or [snippet[:120]]

    @staticmethod
    def _title(payload: PresentationFromChunksInput) -> str:
        if payload.query.strip():
            return f"Presentation: {payload.query.strip()[:60]}"
        return "Study presentation"


def _count_slides(markdown: str) -> int:
    # Count slide separators + 1 (the first slide doesn't start with ---).
    return markdown.count("\n---\n") + (1 if markdown.strip() else 0)
