"""Diagram agent (Phase 2 #6).

Generates Mermaid DSL (flowchart / mindmap / sequence) from a chunk set.
The model returns DSL directly — we strip markdown fences, validate the
first non-empty line matches an expected directive, and refuse if it
doesn't. Mermaid is rendered client-side; no executable surface here.
"""

from __future__ import annotations

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
    DiagramAgentOutput,
    DiagramFromChunksInput,
    RetrievedChunk,
)

log = logging.getLogger(__name__)

DEFAULT_MODEL = "llama-3.1-8b-instant"

_DIRECTIVE_BY_KIND = {
    "flowchart": ("flowchart TD", "flowchart LR", "graph TD", "graph LR"),
    "mindmap": ("mindmap",),
    "sequence": ("sequenceDiagram",),
}

_FENCE_RE = re.compile(r"^\s*```(?:mermaid)?\s*|\s*```\s*$", flags=re.IGNORECASE | re.MULTILINE)

DIAGRAM_SYSTEM_PROMPT = (
    "You are StudyForge, drafting a Mermaid diagram that summarises the "
    "key relationships in a student's materials.\n\n"
    "OUTPUT FORMAT — STRICT:\n"
    "- Output ONLY valid Mermaid DSL. No prose, no markdown fences, no "
    "commentary.\n"
    "- For ``flowchart``: start with ``flowchart TD`` and use ``A[Label] --> "
    "B[Label]`` syntax. Keep node ids short (A, B, C…). 6–12 nodes.\n"
    "- For ``mindmap``: start with ``mindmap`` and use indentation to nest. "
    "Root node is the course topic.\n"
    "- For ``sequence``: start with ``sequenceDiagram`` and use "
    "``Actor->>Other: message`` syntax.\n"
    "- Node labels must be drawn from the supplied materials — don't invent "
    "concepts.\n"
    "- Keep labels under 50 chars; quote any label that contains a colon or "
    "parenthesis."
)


class DiagramAgent:
    name = "diagram.render.v1"
    version = "0.1.0"
    input_model = DiagramFromChunksInput
    output_model = DiagramAgentOutput

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
        payload: DiagramFromChunksInput,
        retrieved_chunks: list[RetrievedChunk],
    ) -> DiagramAgentOutput:
        if not retrieved_chunks:
            return DiagramAgentOutput(
                course_id=payload.course_id,
                renderer="mermaid",
                source=self._stub_dsl(payload, []),
            )
        if self._provider is None:
            return DiagramAgentOutput(
                course_id=payload.course_id,
                renderer="mermaid",
                source=self._stub_dsl(payload, retrieved_chunks),
            )

        try:
            response = await self._call_llm(payload, retrieved_chunks)
        except Exception as exc:
            log.warning("diagram.llm_error fallback_to_stub err=%s", exc)
            return DiagramAgentOutput(
                course_id=payload.course_id,
                renderer="mermaid",
                source=self._stub_dsl(payload, retrieved_chunks),
            )
        dsl = self._clean_and_validate(response.text, payload.kind)
        if not dsl:
            log.warning(
                "diagram.invalid_dsl preview=%r kind=%s",
                response.text[:300],
                payload.kind,
            )
            dsl = self._stub_dsl(payload, retrieved_chunks)
        return DiagramAgentOutput(
            course_id=payload.course_id,
            renderer="mermaid",
            source=dsl,
        )

    async def _call_llm(
        self,
        payload: DiagramFromChunksInput,
        chunks: list[RetrievedChunk],
    ) -> Any:
        assert self._provider is not None
        seed = payload.query or (
            f"Render a {payload.kind} diagram of the key relationships in these materials."
        )
        seed_with_kind = f"{seed}\n\nDiagram kind: {payload.kind}."
        messages = build_messages(
            system_prompt=DIAGRAM_SYSTEM_PROMPT,
            user_query=seed_with_kind,
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

    def _clean_and_validate(self, text: str, kind: str) -> str | None:
        # Strip markdown fences if the model added any.
        cleaned = _FENCE_RE.sub("", text).strip()
        if not cleaned:
            return None
        first_line = next((ln.strip() for ln in cleaned.splitlines() if ln.strip()), "")
        directives = _DIRECTIVE_BY_KIND.get(kind, ())
        if not any(first_line.lower().startswith(d.lower()) for d in directives):
            return None
        # Trim to a max of ~150 lines so a runaway response can't blow up the FE.
        lines = cleaned.splitlines()[:150]
        return "\n".join(lines).strip()

    def _stub_dsl(
        self,
        payload: DiagramFromChunksInput,
        chunks: list[RetrievedChunk],
    ) -> str:
        # Deterministic fallback. For flowchart, link consecutive chunks;
        # for mindmap, branch from a root.
        labels: list[str] = []
        for c in chunks[:8]:
            snippet = " ".join(c.content.split())[:40]
            if snippet:
                labels.append(snippet.replace('"', "'"))
        if not labels:
            labels = ["No materials"]
        if payload.kind == "mindmap":
            lines = ["mindmap", "  root((Materials))"]
            for lbl in labels:
                lines.append(f"    {lbl}")
            return "\n".join(lines)
        if payload.kind == "sequence":
            lines = ["sequenceDiagram", "  participant Student", "  participant Materials"]
            for lbl in labels[:6]:
                lines.append(f"  Materials->>Student: {lbl}")
            return "\n".join(lines)
        # flowchart
        lines = ["flowchart TD"]
        for i, lbl in enumerate(labels):
            node_id = chr(ord("A") + i)
            lines.append(f'  {node_id}["{lbl}"]')
        for i in range(len(labels) - 1):
            a = chr(ord("A") + i)
            b = chr(ord("A") + i + 1)
            lines.append(f"  {a} --> {b}")
        return "\n".join(lines)
