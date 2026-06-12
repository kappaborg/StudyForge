"""Roadmap planner agent (Phase 2 #3).

Chunk-driven: prompts the LLM to synthesize a weekly study plan from the
retrieved chunks. Output is a JSON object {weeks:[{title, milestones:[
{title, effort_min, chunk_id}]}]}. Milestones whose chunk_id isn't in the
supplied set are dropped — same citation-enforcement contract as the
tutor.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

from ..cache import ArtifactCache, chunk_set_hash
from ..llm.contracts import (
    ChannelMessage as LLMChannelMessage,
)
from ..llm.contracts import (
    LLMProvider,
    LLMRequest,
)
from ..metrics import record_artifact_cache_hit
from ..safety.prompt_builder import build_messages
from .contracts import (
    Citation,
    Milestone,
    RetrievedChunk,
    RoadmapFromChunksInput,
    RoadmapPlannerOutput,
)

log = logging.getLogger(__name__)

DEFAULT_MODEL = "llama-3.1-8b-instant"

ROADMAP_SYSTEM_PROMPT = (
    "You are StudyForge, building a weekly study roadmap from a student's "
    "uploaded materials.\n\n"
    "OUTPUT FORMAT — STRICT:\n"
    "- Return a JSON object: {\"weeks\":[{\"title\":..., \"milestones\":[{"
    "\"title\":..., \"effort_min\":30, \"chunk_id\":...}]}]}.\n"
    "- One element per week, in order. ``effort_min`` is an estimated study "
    "time in minutes (10–180). ``chunk_id`` MUST come from the supplied "
    "<untrusted_document> blocks.\n"
    "- 2–4 milestones per week. Order milestones from foundational to advanced.\n"
    "- No markdown fences, no commentary. JSON object only."
)

_JSON_OBJECT_RE = re.compile(r"\{.*?\}", flags=re.DOTALL)


class RoadmapAgent:
    name = "roadmap.plan.v1"
    version = "0.1.0"
    input_model = RoadmapFromChunksInput
    output_model = RoadmapPlannerOutput

    def __init__(
        self,
        provider: LLMProvider | None = None,
        *,
        model: str = DEFAULT_MODEL,
        max_output_tokens: int = 1024,
        temperature: float = 0.3,
        artifact_cache: ArtifactCache | None = None,
    ) -> None:
        self._provider = provider
        self._model = model
        self._max_output_tokens = max_output_tokens
        self._temperature = temperature
        self._artifact_cache = artifact_cache

    async def run(
        self,
        payload: RoadmapFromChunksInput,
        retrieved_chunks: list[RetrievedChunk],
    ) -> RoadmapPlannerOutput:
        if not retrieved_chunks:
            return RoadmapPlannerOutput(
                course_id=payload.course_id,
                title=self._title(payload),
                weeks=payload.weeks,
                milestones=[],
            )

        # ── course-shared artifact cache lookup ──────────────────────────────
        # The week count changes the shape of the plan, so it's part of
        # the key. Roadmaps share unvalidated rows (like flashcards) —
        # the FE labels donor-shared plans distinctly.
        content_hash = self._content_hash(retrieved_chunks, payload.weeks)
        if self._artifact_cache is not None:
            hit = await self._artifact_cache.lookup(
                content_hash=content_hash,
                agent_name=self.name,
                agent_version=self.version,
                require_validated=False,
            )
            if hit is not None:
                record_artifact_cache_hit(self.name, payload.tenant_id)
                log.info(
                    "roadmap.artifact_cache_hit",
                    extra={
                        "agent": self.name,
                        "tenant_id": payload.tenant_id,
                        "donor_tenant_id": hit.donor_tenant_id,
                        "hits": hit.hits,
                        "quality_validated": hit.quality_validated,
                    },
                )
                cached_output = {**hit.output, "course_id": payload.course_id}
                return RoadmapPlannerOutput.model_validate(cached_output)

        if self._provider is None:
            return self._stub_response(payload, retrieved_chunks)

        try:
            response = await self._call_llm(payload, retrieved_chunks)
        except Exception as exc:
            log.warning("roadmap.llm_error fallback_to_stub err=%s", exc)
            return self._stub_response(payload, retrieved_chunks)
        milestones = self._parse_milestones(response.text, retrieved_chunks, payload.weeks)
        if not milestones:
            log.warning(
                "roadmap.empty_parse preview=%r supportive_ids=%s",
                response.text[:400],
                [c.chunk_id for c in retrieved_chunks],
            )
            return self._stub_response(payload, retrieved_chunks)

        output = RoadmapPlannerOutput(
            course_id=payload.course_id,
            title=self._title(payload),
            weeks=payload.weeks,
            milestones=milestones,
        )

        if self._artifact_cache is not None:
            try:
                await self._artifact_cache.store(
                    content_hash=content_hash,
                    agent_name=self.name,
                    agent_version=self.version,
                    output=output.model_dump(mode="json"),
                    donor_tenant_id=payload.tenant_id,
                    donor_course_id=payload.course_id,
                    quality_validated=False,
                )
            except Exception as exc:
                log.warning("roadmap.artifact_cache_store_failed err=%s", exc)

        return output

    def _content_hash(self, chunks: list[RetrievedChunk], weeks: int) -> str:
        base = chunk_set_hash(c.chunk_id for c in chunks)
        return f"{base}:weeks={weeks}"

    async def _call_llm(
        self,
        payload: RoadmapFromChunksInput,
        chunks: list[RetrievedChunk],
    ) -> Any:
        assert self._provider is not None
        seed = payload.query or "Build a study plan covering the materials end-to-end."
        seed_with_weeks = (
            f"{seed}\n\nProduce a plan over exactly {payload.weeks} week(s)."
        )
        messages = build_messages(
            system_prompt=ROADMAP_SYSTEM_PROMPT,
            user_query=seed_with_weeks,
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

    def _parse_milestones(
        self,
        text: str,
        chunks: list[RetrievedChunk],
        weeks: int,
    ) -> list[Milestone]:
        obj = self._extract_json_object(text)
        if obj is None:
            return []
        weeks_arr = obj.get("weeks") if isinstance(obj, dict) else None
        if not isinstance(weeks_arr, list):
            return []
        index = {c.chunk_id: c for c in chunks}
        milestones: list[Milestone] = []
        for week_idx, week in enumerate(weeks_arr[:weeks], start=1):
            if not isinstance(week, dict):
                continue
            week_milestones = week.get("milestones")
            if not isinstance(week_milestones, list):
                continue
            for ordinal, m in enumerate(week_milestones, start=1):
                if not isinstance(m, dict):
                    continue
                title = (m.get("title") or "").strip()
                chunk_id = (m.get("chunk_id") or "").strip()
                effort = m.get("effort_min")
                if not title or chunk_id not in index:
                    continue
                try:
                    effort_min = int(effort) if effort is not None else 30
                except (ValueError, TypeError):
                    effort_min = 30
                effort_min = max(5, min(effort_min, 480))
                milestones.append(
                    Milestone(
                        concept_id=None,
                        title=title[:200],
                        week_index=week_idx,
                        ordinal=ordinal,
                        effort_min=effort_min,
                    )
                )
        return milestones

    @staticmethod
    def _extract_json_object(text: str) -> dict[str, Any] | None:
        try:
            parsed = json.loads(text)
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            pass
        # Greedy match because nested objects break the lazy regex above.
        first = text.find("{")
        last = text.rfind("}")
        if first == -1 or last <= first:
            return None
        try:
            parsed = json.loads(text[first : last + 1])
            return parsed if isinstance(parsed, dict) else None
        except json.JSONDecodeError:
            return None

    def _stub_response(
        self,
        payload: RoadmapFromChunksInput,
        chunks: list[RetrievedChunk],
    ) -> RoadmapPlannerOutput:
        # Distribute chunks roughly evenly across weeks.
        weeks = max(1, payload.weeks)
        milestones: list[Milestone] = []
        per_week = max(1, len(chunks) // weeks)
        for week_idx in range(1, weeks + 1):
            start = (week_idx - 1) * per_week
            slice_chunks = chunks[start : start + per_week]
            for ordinal, c in enumerate(slice_chunks, start=1):
                snippet = " ".join(c.content.split())[:80] or "Study the linked passage"
                milestones.append(
                    Milestone(
                        concept_id=None,
                        title=f"Read · {snippet}",
                        week_index=week_idx,
                        ordinal=ordinal,
                        effort_min=30,
                    )
                )
        return RoadmapPlannerOutput(
            course_id=payload.course_id,
            title=self._title(payload),
            weeks=weeks,
            milestones=milestones,
        )

    @staticmethod
    def _title(payload: RoadmapFromChunksInput) -> str:
        if payload.query.strip():
            return f"Roadmap: {payload.query.strip()[:60]}"
        return f"{payload.weeks}-week study roadmap"


# Citation helper kept here so the stub path can also tag milestones if we
# decide to surface chunk pointers in the persisted Milestone row later.
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
