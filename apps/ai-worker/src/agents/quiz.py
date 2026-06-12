"""Quiz generator agent (Phase 2 #2).

MCQ-only for now — coding/scenario kinds come later. Same retrieve-then-
generate-then-validate shape as the flashcard agent: prompt the model to
emit JSON, drop any item that doesn't cite a real chunk, fall back to a
deterministic stub when no LLM provider is configured.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

from ..llm.contracts import (
    ChannelMessage as LLMChannelMessage,
)
from ..llm.contracts import (
    LLMProvider,
    LLMRequest,
)
from ..safety.prompt_builder import build_messages
from .contracts import (
    Citation,
    QuizFromChunksInput,
    QuizGeneratorOutput,
    QuizItem,
    QuizItemKind,
    RetrievedChunk,
)

log = logging.getLogger(__name__)

DEFAULT_MODEL = "llama-3.1-8b-instant"

QUIZ_SYSTEM_PROMPT = (
    "You are StudyForge, generating multiple-choice quiz questions from a "
    "student's uploaded materials.\n\n"
    "OUTPUT FORMAT — STRICT:\n"
    "- Return a JSON array. Each item: "
    "{\"prompt\":..., \"options\":[\"A\",\"B\",\"C\",\"D\"], "
    "\"correct_index\":0, \"rationale\":..., \"chunk_id\":...}.\n"
    "- ``correct_index`` is 0-based.\n"
    "- ``chunk_id`` MUST be an attribute value from one of the supplied "
    "<untrusted_document> blocks. Never invent chunk_ids.\n"
    "- The rationale (≤ 240 chars) explains why the correct option is right, "
    "grounded in the cited chunk.\n"
    "- Generate plausible distractors — wrong-but-tempting, not obvious filler.\n"
    "- No markdown fences, no commentary. JSON array only."
)

_JSON_ARRAY_RE = re.compile(r"\[\s*\{.*?\}\s*\]", flags=re.DOTALL)


class QuizAgent:
    name = "quiz.generate.v1"
    version = "0.1.0"
    input_model = QuizFromChunksInput
    output_model = QuizGeneratorOutput

    def __init__(
        self,
        provider: LLMProvider | None = None,
        *,
        model: str = DEFAULT_MODEL,
        max_output_tokens: int = 1024,
        temperature: float = 0.3,
    ) -> None:
        self._provider = provider
        self._model = model
        self._max_output_tokens = max_output_tokens
        self._temperature = temperature

    async def run(
        self,
        payload: QuizFromChunksInput,
        retrieved_chunks: list[RetrievedChunk],
    ) -> QuizGeneratorOutput:
        if not retrieved_chunks:
            return QuizGeneratorOutput(
                course_id=payload.course_id,
                title=self._title(payload),
                items=[],
            )

        if self._provider is None:
            return self._stub_response(payload, retrieved_chunks)

        try:
            response = await self._call_llm(payload, retrieved_chunks)
        except Exception as exc:
            log.warning("quiz.llm_error fallback_to_stub err=%s", exc)
            return self._stub_response(payload, retrieved_chunks)
        items = self._parse_items(response.text, retrieved_chunks, payload)
        if not items:
            log.warning(
                "quiz.empty_parse preview=%r supportive_ids=%s",
                response.text[:400],
                [c.chunk_id for c in retrieved_chunks],
            )
            return self._stub_response(payload, retrieved_chunks)

        return QuizGeneratorOutput(
            course_id=payload.course_id,
            title=self._title(payload),
            items=items,
        )

    async def _call_llm(
        self,
        payload: QuizFromChunksInput,
        chunks: list[RetrievedChunk],
    ) -> Any:
        assert self._provider is not None
        seed = payload.query or "Generate questions covering the key concepts in the materials."
        seed_with_count = (
            f"{seed}\n\nGenerate exactly {payload.item_count} multiple-choice "
            f"questions at difficulty ~{payload.difficulty}/100."
        )
        messages = build_messages(
            system_prompt=QUIZ_SYSTEM_PROMPT,
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

    def _parse_items(
        self,
        text: str,
        chunks: list[RetrievedChunk],
        payload: QuizFromChunksInput,
    ) -> list[QuizItem]:
        arr = self._extract_json_array(text)
        if arr is None:
            return []
        index = {c.chunk_id: c for c in chunks}
        out: list[QuizItem] = []
        for item in arr:
            if not isinstance(item, dict):
                continue
            prompt = (item.get("prompt") or "").strip()
            options = item.get("options")
            correct_index = item.get("correct_index")
            rationale = (item.get("rationale") or "").strip()
            chunk_id = (item.get("chunk_id") or "").strip()
            if not prompt or not rationale or chunk_id not in index:
                continue
            if not isinstance(options, list) or len(options) < 2:
                continue
            opts = [str(o).strip() for o in options if str(o).strip()]
            if len(opts) < 2:
                continue
            if not isinstance(correct_index, int) or not (0 <= correct_index < len(opts)):
                continue
            citation = _citation_from(index[chunk_id])
            out.append(
                QuizItem(
                    kind=QuizItemKind.mcq,
                    prompt=prompt,
                    payload={"options": opts, "correct_index": correct_index},
                    rationale=rationale[:1000],
                    difficulty=payload.difficulty,
                    concept_id=None,
                    citations=[citation],
                )
            )
            if len(out) >= payload.item_count:
                break
        return out

    @staticmethod
    def _extract_json_array(text: str) -> list[Any] | None:
        try:
            parsed = json.loads(text)
            if isinstance(parsed, list):
                return parsed
        except json.JSONDecodeError:
            pass
        match = _JSON_ARRAY_RE.search(text)
        if not match:
            return None
        try:
            parsed = json.loads(match.group(0))
            return parsed if isinstance(parsed, list) else None
        except json.JSONDecodeError:
            return None

    def _stub_response(
        self,
        payload: QuizFromChunksInput,
        chunks: list[RetrievedChunk],
    ) -> QuizGeneratorOutput:
        items: list[QuizItem] = []
        for chunk in chunks[: payload.item_count]:
            snippet = " ".join(chunk.content.split())
            if len(snippet) < 40:
                continue
            short = snippet[:160]
            items.append(
                QuizItem(
                    kind=QuizItemKind.mcq,
                    prompt=f"Which statement best matches the passage on page {chunk.page or '—'}?",
                    payload={
                        "options": [
                            short,
                            "This passage is unrelated to the materials.",
                            "The passage discusses a different course's content.",
                            "There is no relevant passage at this location.",
                        ],
                        "correct_index": 0,
                    },
                    rationale=(
                        "No LLM provider configured — this stub item points at the chunk verbatim. "
                        "Set GROQ_API_KEY for real distractors."
                    ),
                    difficulty=payload.difficulty,
                    concept_id=None,
                    citations=[_citation_from(chunk)],
                )
            )
        return QuizGeneratorOutput(
            course_id=payload.course_id,
            title=self._title(payload),
            items=items,
        )

    @staticmethod
    def _title(payload: QuizFromChunksInput) -> str:
        if payload.query.strip():
            return f"Quiz: {payload.query.strip()[:60]}"
        return "Quiz from your materials"


def _citation_from(chunk: RetrievedChunk) -> Citation:
    return Citation(
        chunk_id=chunk.chunk_id,
        doc_id=chunk.doc_id,
        version_id=chunk.version_id,
        page=chunk.page,
        slide=chunk.slide,
        cell=chunk.cell,
        char_start=chunk.char_start,
        char_end=chunk.char_end,
        score=max(0.0, min(1.0, chunk.score)),
    )
