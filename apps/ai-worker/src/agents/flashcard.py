"""Flashcard generator agent (Phase 2 #1).

Chunk-driven path: retrieve top-K chunks (RAG retriever wired in api/
flashcards.py), prompt the LLM to emit a JSON array of Q/A flashcards
with chunk-id citations, validate + parse the JSON, drop any card
lacking a real citation, return the deck.

When no LLM is configured, returns a deterministic stub deck constructed
from chunk content so the UI can still demo without an API key.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

from ..llm.contracts import (
    ChannelMessage as LLMChannelMessage,
    LLMProvider,
    LLMRequest,
)
from ..safety.prompt_builder import build_messages
from .contracts import (
    Citation,
    FlashcardFromChunksInput,
    Flashcard,
    FlashcardGeneratorOutput,
    FlashcardKind,
    RetrievedChunk,
)

log = logging.getLogger(__name__)

DEFAULT_MODEL = "llama-3.1-8b-instant"

FLASHCARD_SYSTEM_PROMPT = (
    "You are StudyForge, generating exam-ready flashcards from a student's "
    "uploaded materials.\n\n"
    "OUTPUT FORMAT — STRICT:\n"
    "- Return a JSON array. Each element has keys: \"front\", \"back\", \"chunk_id\".\n"
    "- The front is a question or prompt; the back is a concise (≤ 240 chars) answer.\n"
    "- ``chunk_id`` MUST be one of the chunk_ids attribute values from the "
    "supplied <untrusted_document> blocks. Never invent chunk_ids.\n"
    "- Example: [{\"front\":\"What is gradient descent?\",\"back\":\"An iterative optimisation "
    "algorithm that moves against the gradient.\",\"chunk_id\":\"abc-123\"}]\n"
    "- Do NOT wrap the JSON in markdown fences or commentary. Output the JSON array only.\n"
    "- Aim for diversity — different sub-topics, no near-duplicates, no trivial recall."
)

# Match the model's JSON output even if it sneaks in fences or prose.
_JSON_ARRAY_RE = re.compile(r"\[\s*\{.*?\}\s*\]", flags=re.DOTALL)


class FlashcardAgent:
    """Implements the Agent protocol structurally."""

    name = "flashcard.generate.v1"
    version = "0.1.0"
    input_model = FlashcardFromChunksInput
    output_model = FlashcardGeneratorOutput

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
        payload: FlashcardFromChunksInput,
        retrieved_chunks: list[RetrievedChunk],
    ) -> FlashcardGeneratorOutput:
        if not retrieved_chunks:
            return FlashcardGeneratorOutput(
                course_id=payload.course_id,
                deck_title=self._title(payload),
                flashcards=[],
            )

        if self._provider is None:
            return self._stub_response(payload, retrieved_chunks)

        try:
            response = await self._call_llm(payload, retrieved_chunks)
        except Exception as exc:  # noqa: BLE001 — degrade to stub on any LLM failure (rate limit, network, etc.)
            log.warning("flashcard.llm_error fallback_to_stub err=%s", exc)
            return self._stub_response(payload, retrieved_chunks)
        cards = self._parse_cards(response.text, retrieved_chunks, payload.deck_size)
        if not cards:
            # Model produced no validatable cards; fall back to stub so the
            # student isn't blocked.
            log.warning(
                "flashcard.empty_parse preview=%r supportive_ids=%s",
                response.text[:400],
                [c.chunk_id for c in retrieved_chunks],
            )
            return self._stub_response(payload, retrieved_chunks)

        return FlashcardGeneratorOutput(
            course_id=payload.course_id,
            deck_title=self._title(payload),
            flashcards=cards,
        )

    # ── prompt + call ────────────────────────────────────────────────────────

    async def _call_llm(
        self,
        payload: FlashcardFromChunksInput,
        chunks: list[RetrievedChunk],
    ) -> Any:
        assert self._provider is not None
        user_seed = payload.query or "Generate flashcards covering the key concepts in the materials."
        seed_with_size = f"{user_seed}\n\nGenerate exactly {payload.deck_size} cards."
        channel_messages = build_messages(
            system_prompt=FLASHCARD_SYSTEM_PROMPT,
            user_query=seed_with_size,
            retrieved_chunks=chunks,
        )
        llm_messages = [
            LLMChannelMessage(role=m.role, content=m.content) for m in channel_messages
        ]
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

    # ── parsing ──────────────────────────────────────────────────────────────

    def _parse_cards(
        self,
        text: str,
        chunks: list[RetrievedChunk],
        deck_size: int,
    ) -> list[Flashcard]:
        payload = self._extract_json_array(text)
        if payload is None:
            return []
        index = {c.chunk_id: c for c in chunks}
        out: list[Flashcard] = []
        for item in payload:
            if not isinstance(item, dict):
                continue
            front = (item.get("front") or "").strip()
            back = (item.get("back") or "").strip()
            chunk_id = (item.get("chunk_id") or "").strip()
            if not front or not back or chunk_id not in index:
                continue
            citation = _citation_from(index[chunk_id])
            out.append(
                Flashcard(
                    kind=FlashcardKind.qa,
                    front=front,
                    back=back[:1000],
                    concept_id=None,
                    citations=[citation],
                )
            )
            if len(out) >= deck_size:
                break
        return out

    @staticmethod
    def _extract_json_array(text: str) -> list[Any] | None:
        # First try the whole string.
        try:
            parsed = json.loads(text)
            if isinstance(parsed, list):
                return parsed
        except json.JSONDecodeError:
            pass
        # Then look for the first JSON array substring.
        match = _JSON_ARRAY_RE.search(text)
        if not match:
            return None
        try:
            parsed = json.loads(match.group(0))
            return parsed if isinstance(parsed, list) else None
        except json.JSONDecodeError:
            return None

    # ── stub fallback (no provider) ──────────────────────────────────────────

    def _stub_response(
        self,
        payload: FlashcardFromChunksInput,
        chunks: list[RetrievedChunk],
    ) -> FlashcardGeneratorOutput:
        cards: list[Flashcard] = []
        for chunk in chunks[: payload.deck_size]:
            snippet = " ".join(chunk.content.split())
            if len(snippet) < 40:
                continue
            front = f"What does this passage describe? (page {chunk.page or '—'})"
            back = snippet[:240] + ("…" if len(snippet) > 240 else "")
            cards.append(
                Flashcard(
                    kind=FlashcardKind.qa,
                    front=front,
                    back=back,
                    concept_id=None,
                    citations=[_citation_from(chunk)],
                )
            )
        return FlashcardGeneratorOutput(
            course_id=payload.course_id,
            deck_title=self._title(payload),
            flashcards=cards,
        )

    @staticmethod
    def _title(payload: FlashcardFromChunksInput) -> str:
        if payload.query.strip():
            return f"Flashcards: {payload.query.strip()[:60]}"
        return "Flashcards from your materials"


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
