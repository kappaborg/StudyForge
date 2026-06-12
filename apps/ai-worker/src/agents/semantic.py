"""Semantic analyzer agent (Phase 2 #4).

Extracts ``Concept`` nodes and ``ConceptEdge`` relations from a set of
retrieved chunks. The LLM emits JSON with stable model-local concept ids
(``c1``, ``c2``, …); we map those to real UUIDs in the API layer at
persist time. Every concept carries the ``chunk_ids`` it draws from so
the eventual graph view can deep-link back to the source passages.
"""

from __future__ import annotations

import json
import logging
import re
import uuid
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
    Concept,
    ConceptChunkRef,
    ConceptEdge,
    ConceptEdgeKind,
    ConceptExtractionResult,
    RetrievedChunk,
    SemanticAnalyzerFromChunksInput,
)

log = logging.getLogger(__name__)

DEFAULT_MODEL = "llama-3.1-8b-instant"

_ALLOWED_EDGE_KINDS = {k.value for k in ConceptEdgeKind}

SEMANTIC_SYSTEM_PROMPT = (
    "You are StudyForge, mapping a course's materials into a small concept "
    "graph for a student.\n\n"
    "OUTPUT FORMAT — STRICT:\n"
    "- Return a JSON object with two keys: \"concepts\" and \"edges\".\n"
    "- concepts: array of {\"local_id\":\"c1\", \"label\":..., "
    "\"description\":..., \"difficulty\":0..100, \"chunk_ids\":[...]}.\n"
    "- edges: array of {\"from\":\"c1\", \"to\":\"c2\", \"kind\":..., "
    "\"weight\":0..1}. ``kind`` MUST be one of: "
    f"{sorted(_ALLOWED_EDGE_KINDS)}.\n"
    "- ``chunk_ids`` MUST come from the supplied <untrusted_document> blocks. "
    "Every concept needs at least one chunk_id.\n"
    "- Concepts: 5–15 high-signal topics, deduplicated. Use stable local_ids "
    "(c1, c2, …) and only reference those in edges.\n"
    "- Edges: only include relations the materials directly support. "
    "Prefer ``prerequisite_of`` for foundations → advanced; ``related_to`` "
    "for sibling concepts.\n"
    "- No markdown fences, no commentary. JSON object only."
)


class SemanticAnalyzerAgent:
    name = "semantic.analyze.v1"
    version = "0.1.0"
    input_model = SemanticAnalyzerFromChunksInput
    output_model = ConceptExtractionResult

    def __init__(
        self,
        provider: LLMProvider | None = None,
        *,
        model: str = DEFAULT_MODEL,
        max_output_tokens: int = 1024,
        temperature: float = 0.2,
    ) -> None:
        self._provider = provider
        self._model = model
        self._max_output_tokens = max_output_tokens
        self._temperature = temperature

    async def run(
        self,
        payload: SemanticAnalyzerFromChunksInput,
        retrieved_chunks: list[RetrievedChunk],
    ) -> ConceptExtractionResult:
        if not retrieved_chunks:
            return ConceptExtractionResult(
                course_id=payload.course_id,
                concepts=[],
                edges=[],
                refs=[],
            )
        if self._provider is None:
            return self._stub_response(payload, retrieved_chunks)

        try:
            response = await self._call_llm(payload, retrieved_chunks)
        except Exception as exc:
            log.warning("semantic.llm_error fallback_to_stub err=%s", exc)
            return self._stub_response(payload, retrieved_chunks)
        parsed = self._parse(response.text, retrieved_chunks, payload)
        if parsed is None or not parsed.concepts:
            log.warning(
                "semantic.empty_parse preview=%r supportive_ids=%s",
                response.text[:400],
                [c.chunk_id for c in retrieved_chunks],
            )
            return self._stub_response(payload, retrieved_chunks)
        return parsed

    # ── LLM call ─────────────────────────────────────────────────────────────

    async def _call_llm(
        self,
        payload: SemanticAnalyzerFromChunksInput,
        chunks: list[RetrievedChunk],
    ) -> Any:
        assert self._provider is not None
        seed = (
            f"Extract a concept graph from these materials. Aim for ≤ "
            f"{payload.max_concepts} concepts."
        )
        messages = build_messages(
            system_prompt=SEMANTIC_SYSTEM_PROMPT,
            user_query=seed,
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

    # ── parsing ──────────────────────────────────────────────────────────────

    def _parse(
        self,
        text: str,
        chunks: list[RetrievedChunk],
        payload: SemanticAnalyzerFromChunksInput,
    ) -> ConceptExtractionResult | None:
        obj = _extract_json_object(text)
        if not isinstance(obj, dict):
            return None
        raw_concepts = obj.get("concepts")
        raw_edges = obj.get("edges")
        if not isinstance(raw_concepts, list):
            return None

        chunk_index = {c.chunk_id for c in chunks}
        concepts: list[Concept] = []
        refs: list[ConceptChunkRef] = []
        local_to_real: dict[str, str] = {}
        seen_labels: set[str] = set()

        for raw in raw_concepts[: payload.max_concepts]:
            if not isinstance(raw, dict):
                continue
            local_id = str(raw.get("local_id") or "").strip()
            label = (raw.get("label") or "").strip()
            description = (raw.get("description") or "").strip() or None
            difficulty = raw.get("difficulty")
            chunk_refs = raw.get("chunk_ids")
            if not local_id or not label:
                continue
            if label.lower() in seen_labels:
                continue
            if not isinstance(chunk_refs, list):
                continue
            valid_chunks = [c for c in chunk_refs if isinstance(c, str) and c in chunk_index]
            if not valid_chunks:
                continue
            try:
                diff_int = int(difficulty) if difficulty is not None else 50
            except (TypeError, ValueError):
                diff_int = 50
            diff_int = max(0, min(diff_int, 100))

            real_id = str(uuid.uuid4())
            local_to_real[local_id] = real_id
            seen_labels.add(label.lower())

            # ``Concept`` (Phase-0 contract) wants ``block_refs`` indices, not
            # chunk_ids. We emit empty indices and stash chunk_ids in the
            # parallel ``ConceptChunkRef`` collection instead.
            concepts.append(
                Concept(
                    id=real_id,
                    label=label[:200],
                    description=description[:1000] if description else None,
                    difficulty=diff_int,
                    block_refs=[0],
                )
            )
            refs.append(ConceptChunkRef(concept_id=real_id, chunk_ids=valid_chunks))

        # Edges
        edges: list[ConceptEdge] = []
        seen_edges: set[tuple[str, str, str]] = set()
        if isinstance(raw_edges, list):
            for raw in raw_edges:
                if not isinstance(raw, dict):
                    continue
                fr = str(raw.get("from") or "").strip()
                to = str(raw.get("to") or "").strip()
                kind = str(raw.get("kind") or "").strip()
                weight = raw.get("weight")
                if fr not in local_to_real or to not in local_to_real:
                    continue
                if fr == to:
                    continue
                if kind not in _ALLOWED_EDGE_KINDS:
                    continue
                try:
                    w = float(weight) if weight is not None else 1.0
                except (TypeError, ValueError):
                    w = 1.0
                w = max(0.0, min(w, 1.0))
                from_real = local_to_real[fr]
                to_real = local_to_real[to]
                key = (from_real, to_real, kind)
                if key in seen_edges:
                    continue
                seen_edges.add(key)
                edges.append(
                    ConceptEdge(
                        from_id=from_real,
                        to_id=to_real,
                        kind=ConceptEdgeKind(kind),
                        weight=w,
                    )
                )

        return ConceptExtractionResult(
            course_id=payload.course_id,
            concepts=concepts,
            edges=edges,
            refs=refs,
        )

    # ── stub fallback ───────────────────────────────────────────────────────

    def _stub_response(
        self,
        payload: SemanticAnalyzerFromChunksInput,
        chunks: list[RetrievedChunk],
    ) -> ConceptExtractionResult:
        # One concept per chunk excerpt; no edges. Useful so the UI still
        # has something to render without an API key.
        concepts: list[Concept] = []
        refs: list[ConceptChunkRef] = []
        for chunk in chunks[: payload.max_concepts]:
            snippet = " ".join(chunk.content.split())[:80]
            if not snippet:
                continue
            real_id = str(uuid.uuid4())
            concepts.append(
                Concept(
                    id=real_id,
                    label=snippet,
                    description=None,
                    difficulty=50,
                    block_refs=[0],
                )
            )
            refs.append(ConceptChunkRef(concept_id=real_id, chunk_ids=[chunk.chunk_id]))
        return ConceptExtractionResult(
            course_id=payload.course_id,
            concepts=concepts,
            edges=[],
            refs=refs,
        )


def _extract_json_object(text: str) -> dict[str, Any] | None:
    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            return parsed
    except json.JSONDecodeError:
        pass
    first = text.find("{")
    last = text.rfind("}")
    if first == -1 or last <= first:
        return None
    try:
        parsed = json.loads(text[first : last + 1])
        return parsed if isinstance(parsed, dict) else None
    except json.JSONDecodeError:
        return None


# Available if a future caller wants to scrub fenced output before JSON parsing.
_JSON_FENCE_RE = re.compile(r"```(?:json)?\s*|```", flags=re.IGNORECASE)
