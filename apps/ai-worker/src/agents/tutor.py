"""Tutor agent — streaming RAG chat with citation enforcement.

Phase-0 behaviour: returns a typed refusal when no retrieved chunk supports
the query (the load-bearing invariant from §5).

Phase-1 behaviour (this commit): when supportive chunks AND an ``LLMProvider``
are present, builds a channel-separated prompt via ``safety.prompt_builder``,
calls the provider, and parses ``[chunk:<id>]`` citation tags from the
response. Tags that don't map to a retrieved chunk are silently dropped
(potential hallucination); a response with zero valid citations is itself a
refusal — never returned to the user as an "answer."

The streaming surface lives at the gateway / SSE layer; the agent here
returns a single ``TutorOutput`` whose ``text`` already has the citation tags
stripped (the structured ``citations`` list carries the linkage).
"""

from __future__ import annotations

import logging
import re
from collections.abc import Iterable

from ..cache import CacheHit, SemanticCache, chunk_set_hash
from ..llm.contracts import (
    ChannelMessage as LLMChannelMessage,
)
from ..llm.contracts import (
    LLMProvider,
    LLMRequest,
    LLMResponse,
)
from ..metrics import record_cache_hit, record_provider_call
from ..safety.prompt_builder import build_messages
from .contracts import (
    Citation,
    RetrievedChunk,
    TutorInput,
    TutorOutput,
)

log = logging.getLogger(__name__)

# Score threshold for "this chunk supports a claim." Chunks arrive carrying
# the retriever's RRF-normalised score (top hit = 1.0), so values much above
# ~0.3 start excluding legitimate lower-ranked support. Tuned per provider in
# Phase 1 mid via the eval harness.
SUPPORT_THRESHOLD = 0.2

# Citation tag in the model output, e.g. ``[chunk:c-1]``. The system prompt
# instructs the model to use this exact form.
CITATION_TAG_RE = re.compile(r"\[chunk:([A-Za-z0-9_\-]+)\]")

# Default model used when no per-agent override is set. The orchestrator can
# override at construction time.
DEFAULT_MODEL = "llama-3.1-8b-instant"

# Words considered too generic to justify a citation; used when no chunk meets
# the support threshold and we surface revision suggestions instead.
_GENERIC_TOKENS = {"the", "a", "an", "is", "are", "of", "and", "to"}

TUTOR_SYSTEM_PROMPT = (
    "You are StudyForge, an academic tutor. Answer ONLY from the provided "
    "<untrusted_document> blocks.\n\n"
    "OUTPUT FORMAT — STRICT:\n"
    "- After EVERY sentence that states a fact, append a citation tag using "
    "the EXACT chunk_id attribute from the supporting <untrusted_document> "
    "block. The tag must look like [chunk:<chunk_id>] with no spaces. The "
    "chunk_id is often a UUID (e.g. 649fe193-5573-4de3-8d63-7958f425945a).\n"
    "- Example: \"The pipeline extracts frames from video [chunk:649fe193-5573-4de3-8d63-7958f425945a]. "
    "Metadata is preserved at the sequence level [chunk:1f0294de-030e-408e-8b78-1a0443a934d3].\"\n"
    "- If no block supports the question, respond with exactly: "
    "\"I could not find this in your materials.\"\n"
    "- Never invent chunk_ids; only use ones that appear in the provided blocks.\n"
    "- Be concise. Prefer examples over jargon. Adapt depth to the student's "
    "apparent skill level."
)


class TutorAgent:
    """Implements the ``Agent`` protocol structurally."""

    name = "tutor.answer.v1"
    version = "0.2.0"
    input_model = TutorInput
    output_model = TutorOutput

    def __init__(
        self,
        provider: LLMProvider | None = None,
        *,
        model: str = DEFAULT_MODEL,
        max_output_tokens: int = 768,
        temperature: float = 0.2,
        cache: SemanticCache | None = None,
        cache_similarity_threshold: float = 0.92,
        cache_freshness_sec: int = 3600,
    ) -> None:
        self._provider = provider
        self._model = model
        self._max_output_tokens = max_output_tokens
        self._temperature = temperature
        self._cache = cache
        self._cache_threshold = cache_similarity_threshold
        self._cache_freshness_sec = cache_freshness_sec

    async def run(self, payload: TutorInput) -> TutorOutput:
        supportive = self._select_supportive(payload.retrieved_chunks)

        if not supportive:
            return self._refuse_no_chunks(payload)

        if self._provider is None:
            # Dev/test path: keep behaviour stable when no provider is wired.
            # Production code MUST pass a provider; the worker registers an
            # adapter at boot.
            log.warning(
                "tutor.answer.v1 invoked without an LLMProvider — returning "
                "deterministic stub; configure a provider before deploying."
            )
            return self._stub_response(payload, supportive)

        # ── semantic cache lookup ────────────────────────────────────────────
        # Key: (tenant, course, chunk_set_hash, query embedding). A corpus
        # change invalidates the row silently because the hash differs.
        chunk_hash = chunk_set_hash(c.chunk_id for c in supportive)
        cached = await self._lookup_cache(payload, chunk_hash)
        if cached is not None:
            record_cache_hit(payload.tenant_id)
            log.info(
                "tutor.cache_hit",
                extra={
                    "agent": self.name,
                    "session_id": payload.session_id,
                    "similarity": cached.similarity,
                    "age_sec": cached.age_sec,
                    "hits": cached.hits,
                    "citations": len(cached.citations),
                },
            )
            return TutorOutput(
                session_id=payload.session_id,
                refusal=False,
                text=cached.response,
                citations=cached.citations,
                suggestions=[],
            )

        try:
            response = await self._call_llm(payload, supportive)
        except Exception as exc:
            log.exception("tutor LLM call failed: %s", exc)
            return self._refuse_llm_error(payload, supportive)

        record_provider_call(
            response.provider_id,
            tokens_in=response.usage.tokens_in,
            tokens_out=response.usage.tokens_out,
            cached_in=response.usage.cached_tokens_in,
            cache_hit=response.usage.cache_hit,
        )

        # Cost telemetry. Logged WITHOUT message content so the audit + log
        # pipeline never carries student PII or chunk text. Downstream cost
        # ledger writers (Phase 1 #8 onward) read structured fields from here.
        log.info(
            "tutor.llm_call",
            extra={
                "provider_id": response.provider_id,
                "model": response.model,
                "tokens_in": response.usage.tokens_in,
                "tokens_out": response.usage.tokens_out,
                "cached_tokens_in": response.usage.cached_tokens_in,
                "cache_hit": response.usage.cache_hit,
                "cache_hit_ratio": response.usage.cache_hit_ratio,
                "finish_reason": response.finish_reason,
                "agent": self.name,
            },
        )

        cited_ids = _extract_cited_chunk_ids(response.text)
        supportive_index = {c.chunk_id: c for c in supportive}
        valid_citations: list[Citation] = []
        for cid in cited_ids:
            chunk = supportive_index.get(cid)
            if chunk is None:
                continue
            valid_citations.append(self._citation_from(chunk))

        if not valid_citations:
            log.warning(
                "tutor.uncited_response tag_matches=%s supportive_ids=%s preview=%r",
                cited_ids,
                [c.chunk_id for c in supportive],
                response.text[:500],
            )
            return self._refuse_uncited(payload, supportive)

        cleaned_text = _strip_citation_tags(response.text).strip()

        # Cache write happens AFTER the citation-enforcement check so we never
        # cache a refusal as a positive answer. If the cache write fails (e.g.
        # transient DB blip) we still return the live answer to the user.
        await self._store_cache(payload, chunk_hash, cleaned_text, valid_citations)

        return TutorOutput(
            session_id=payload.session_id,
            refusal=False,
            text=cleaned_text,
            citations=valid_citations,
            suggestions=[],
        )

    # ── internal ────────────────────────────────────────────────────────────

    def _select_supportive(self, chunks: list[RetrievedChunk]) -> list[RetrievedChunk]:
        return [c for c in chunks if c.score >= SUPPORT_THRESHOLD]

    async def _lookup_cache(
        self, payload: TutorInput, chunk_hash: str
    ) -> CacheHit | None:
        if self._cache is None or payload.tenant_id is None:
            return None
        try:
            return await self._cache.lookup(
                query=payload.query,
                tenant_id=payload.tenant_id,
                course_id=payload.course_id,
                chunk_set_hash=chunk_hash,
                similarity_threshold=self._cache_threshold,
            )
        except Exception as exc:
            log.warning("tutor cache lookup failed: %s", exc)
            return None

    async def _store_cache(
        self,
        payload: TutorInput,
        chunk_hash: str,
        text: str,
        citations: list[Citation],
    ) -> None:
        if self._cache is None or payload.tenant_id is None:
            return
        try:
            await self._cache.store(
                query=payload.query,
                tenant_id=payload.tenant_id,
                course_id=payload.course_id,
                chunk_set_hash=chunk_hash,
                response=text,
                citations=citations,
                freshness_sec=self._cache_freshness_sec,
            )
        except Exception as exc:
            log.warning("tutor cache store failed: %s", exc)

    async def _call_llm(
        self,
        payload: TutorInput,
        supportive: list[RetrievedChunk],
    ) -> LLMResponse:
        assert self._provider is not None  # narrowing for mypy

        channel_messages = build_messages(
            system_prompt=TUTOR_SYSTEM_PROMPT,
            user_query=payload.query,
            retrieved_chunks=supportive,
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
                # Mark the system prompt + retrieved chunks as a cacheable
                # prefix. The Anthropic adapter translates this into
                # ``cache_control: {type: "ephemeral"}`` on the system block;
                # OpenAI applies its automatic caching when prefixes are
                # stable; Groq ignores it. A 3-turn tutor session typically
                # pays for the system + chunks once across all turns.
                cache_prefix_boundary=1,
            )
        )

    # ── refusal builders ─────────────────────────────────────────────────────

    def _refuse_no_chunks(self, payload: TutorInput) -> TutorOutput:
        return TutorOutput(
            session_id=payload.session_id,
            refusal=True,
            text=(
                "I could not find this in your uploaded materials. Try asking "
                "about one of the related topics below, or upload additional "
                "lecture notes that cover this concept."
            ),
            citations=[],
            suggestions=self._suggestions_from_corpus(payload),
        )

    def _refuse_uncited(
        self, payload: TutorInput, supportive: list[RetrievedChunk]
    ) -> TutorOutput:
        return TutorOutput(
            session_id=payload.session_id,
            refusal=True,
            text=(
                "I could not produce a citation-grounded answer for this "
                "question — the model's response did not reference any of the "
                "retrieved sources. Try rephrasing the question or uploading "
                "more directly relevant material."
            ),
            citations=[],
            suggestions=_dedupe_preserving_order(
                self._first_meaningful_phrase(c.content) for c in supportive
            )[:3],
        )

    def _refuse_llm_error(
        self, payload: TutorInput, supportive: list[RetrievedChunk]
    ) -> TutorOutput:
        return TutorOutput(
            session_id=payload.session_id,
            refusal=True,
            text=(
                "I could not reach the language model to answer this question. "
                "Try again in a moment."
            ),
            citations=[],
            suggestions=[
                self._first_meaningful_phrase(c.content) for c in supportive[:3]
            ],
        )

    def _stub_response(
        self, payload: TutorInput, supportive: list[RetrievedChunk]
    ) -> TutorOutput:
        # No LLM provider configured. Render the top supporting excerpts so
        # the user still gets something concrete from their materials. Set
        # GROQ_API_KEY (or OPENAI/ANTHROPIC) for a real synthesised answer.
        top = supportive[:3]
        excerpts: list[str] = []
        for chunk in top:
            snippet = " ".join(chunk.content.split())[:280]
            excerpts.append(f"[chunk:{chunk.chunk_id}] {snippet}…")
        body = "\n\n".join(excerpts) if excerpts else "(no supporting excerpts)"
        text = (
            "No LLM provider key is configured — showing the top excerpts "
            "from your materials instead. Set GROQ_API_KEY in `.env` and "
            "restart the worker for a synthesised answer.\n\n"
            + body
        )
        return TutorOutput(
            session_id=payload.session_id,
            refusal=False,
            text=text,
            citations=[self._citation_from(c) for c in top],
            suggestions=[],
        )

    # ── suggestion helper (Phase-2 KG traversal replaces this) ──────────────

    def _suggestions_from_corpus(self, payload: TutorInput) -> list[str]:
        ranked = sorted(payload.retrieved_chunks, key=lambda c: c.score, reverse=True)
        phrases = (
            self._first_meaningful_phrase(c.content)
            for c in ranked
            if c.content.strip()
        )
        return _dedupe_preserving_order(phrases)[:3]

    @staticmethod
    def _first_meaningful_phrase(text: str) -> str:
        tokens = [t for t in text.replace("\n", " ").split() if t]
        meaningful: list[str] = []
        for token in tokens:
            cleaned = token.strip(".,;:()[]{}\"'").lower()
            if cleaned and cleaned not in _GENERIC_TOKENS:
                meaningful.append(token)
            if len(meaningful) >= 6:
                break
        return " ".join(meaningful) or text[:60]

    @staticmethod
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
            score=chunk.score,
        )


# ─────────────────────────────────────────────────────────────────────────────
# Citation-tag parser (pure functions, exported for testing)
# ─────────────────────────────────────────────────────────────────────────────


def _extract_cited_chunk_ids(text: str) -> list[str]:
    """Return chunk ids in the order they first appear, deduplicated."""
    seen: list[str] = []
    seen_set: set[str] = set()
    for match in CITATION_TAG_RE.finditer(text):
        cid = match.group(1)
        if cid in seen_set:
            continue
        seen.append(cid)
        seen_set.add(cid)
    return seen


def _strip_citation_tags(text: str) -> str:
    """Remove ``[chunk:…]`` markers from the user-visible text. The structured
    citations carry the linkage and the UI renders them as superscript refs."""
    return CITATION_TAG_RE.sub("", text)


def _dedupe_preserving_order(items: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for item in items:
        if item in seen:
            continue
        seen.add(item)
        out.append(item)
    return out
