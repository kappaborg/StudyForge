"""POST /v1/ingest/deep-index — LLM-driven heading extraction.

When the cheap regex chunker can't find chapters in a document (slides
without "Chapter N" markers, lecture notes with author-style headings,
weird PDF TOCs), this endpoint asks an LLM to read a sample of the
document and produce a structured chapter/section assignment per chunk.

Design tradeoffs:

  • Sample, don't blast.  We send at most 50 chunk previews (~200 chars
    each) per LLM call. Larger docs sample uniformly; the bulk of chapter
    boundaries are detectable from this. Keeps the LLM input ~10k tokens.
  • Backfill only.  We never overwrite chunks that already have a
    ``chapter`` from the regex pass. The LLM is a fallback for the
    chunks regex missed, not a competitor.
  • Fail open.  If the LLM is unreachable or returns nonsense, the
    chunks stay regex-tagged. The endpoint reports ``updated_chunks=0``
    rather than 500-ing.
  • Tenant scoping.  The worker has no notion of "user owns this
    document" — that's enforced upstream at the API gateway. The worker
    refuses if ``document.tenantId`` doesn't match the request.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

from fastapi import APIRouter, HTTPException
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool
from pydantic import BaseModel, ConfigDict

from ..llm.contracts import ChannelMessage, LLMProvider, LLMRequest

log = logging.getLogger(__name__)

# Cap on chunks sampled per call. Anything beyond this stays
# regex-tagged. For a typical 60-page lecture deck this captures every
# section header twice over.
_MAX_SAMPLE = 50
# Max chars per chunk preview sent to the LLM. Keeps total prompt small.
_PREVIEW_CHARS = 220
# Documents with one chunk or less than this many characters of total
# content are short enough that deep-indexing won't produce useful
# chapter/section structure. We short-circuit before paying for the
# LLM call. 2000 chars ≈ 300 words ≈ a short YouTube clip or one
# paragraph of notes.
_MIN_CHARS_TO_DEEP_INDEX = 2_000


class DeepIndexRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    tenant_id: str
    document_id: str
    model: str = "llama-3.3-70b-versatile"
    provider_id: str = "groq"


class DeepIndexResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    document_id: str
    sampled_chunks: int
    updated_chunks: int
    chapters_found: int
    sections_found: int = 0
    skipped_reason: str | None = None


def build_router(
    *,
    pool: AsyncConnectionPool,
    get_provider: Any,  # callable: (provider_id: str) -> LLMProvider | None
) -> APIRouter:
    router = APIRouter(prefix="/v1/ingest", tags=["ingest"])

    @router.post("/deep-index", response_model=DeepIndexResponse)
    async def deep_index(req: DeepIndexRequest) -> DeepIndexResponse:
        provider: LLMProvider | None = get_provider(req.provider_id)
        if provider is None:
            return DeepIndexResponse(
                document_id=req.document_id,
                sampled_chunks=0,
                updated_chunks=0,
                chapters_found=0,
                skipped_reason=f"LLM provider {req.provider_id!r} not configured",
            )

        # 1. Load chunks for the document, scoped to the requesting tenant.
        rows = await _load_chunks(pool, req.tenant_id, req.document_id)
        if not rows:
            raise HTTPException(status_code=404, detail="Document has no chunks (or not found).")

        # 1a. Short-circuit on materials too small to benefit. A single-chunk
        #     doc (short YouTube clip, single-page note) has no internal
        #     structure for the LLM to find; spending a call on it is waste.
        total_chars = sum(len(r.get("content") or "") for r in rows)
        if len(rows) <= 1 or total_chars < _MIN_CHARS_TO_DEEP_INDEX:
            log.info(
                "deep_index.skipped_short doc=%s chunks=%d chars=%d",
                req.document_id,
                len(rows),
                total_chars,
            )
            return DeepIndexResponse(
                document_id=req.document_id,
                sampled_chunks=len(rows),
                updated_chunks=0,
                chapters_found=0,
                skipped_reason=(
                    "This material is too short to benefit from deep-indexing — "
                    "it's already as structured as it gets."
                ),
            )

        # 2. Build the sample — uniformly across the doc to cover early and
        #    late headings even on long materials.
        sample = _uniform_sample(rows, _MAX_SAMPLE)

        # 3. Ask the LLM.
        try:
            assignments = await _ask_llm(provider, req.model, sample)
        except Exception as exc:
            log.warning("deep_index.llm_failed err=%s", exc)
            return DeepIndexResponse(
                document_id=req.document_id,
                sampled_chunks=len(sample),
                updated_chunks=0,
                chapters_found=0,
                skipped_reason=f"LLM call failed: {exc}",
            )

        # 4. Backfill chunks that don't already have a chapter from regex.
        #    We respect prior tags — the regex pass had ground-truth heading
        #    text; the LLM is filling gaps, not relitigating.
        updated, chapters, sections = await _backfill(pool, sample, assignments)
        log.info(
            "deep_index.complete doc=%s sampled=%d updated=%d chapters=%d sections=%d",
            req.document_id,
            len(sample),
            updated,
            chapters,
            sections,
        )
        # If we sampled real chunks but the LLM found nothing to tag,
        # surface that honestly. "0 updated" alone reads like a failure;
        # naming the reason lets the FE show a friendly explanation
        # instead of a misleading "Deep-indexed · 0 chapters" success.
        skipped: str | None = None
        if updated == 0:
            skipped = (
                "No chapter or section markers detected in this material — "
                "it's likely a continuous talk or unstructured notes, so "
                "deep-indexing has nothing to backfill."
            )
        return DeepIndexResponse(
            document_id=req.document_id,
            sampled_chunks=len(sample),
            updated_chunks=updated,
            chapters_found=chapters,
            sections_found=sections,
            skipped_reason=skipped,
        )

    return router


# ── data shaping ─────────────────────────────────────────────────────────────


async def _load_chunks(
    pool: AsyncConnectionPool, tenant_id: str, document_id: str
) -> list[dict[str, Any]]:
    sql = """
        SELECT c.id, c.ordinal, c.page, c.content, c.meta
          FROM "Chunk" c
          JOIN "DocumentVersion" v ON v.id = c."documentVersionId"
          JOIN "Document"        d ON d.id = v."documentId"
         WHERE d.id = %(doc)s::uuid
           AND d."tenantId" = %(tenant)s::uuid
           AND d."deletedAt" IS NULL
         ORDER BY c.ordinal ASC
    """
    async with pool.connection() as conn, conn.cursor(row_factory=dict_row) as cur:
        await cur.execute(sql, {"doc": document_id, "tenant": tenant_id})
        return list(await cur.fetchall())


def _uniform_sample(rows: list[dict[str, Any]], cap: int) -> list[dict[str, Any]]:
    if len(rows) <= cap:
        return rows
    # Pick ``cap`` rows spaced as evenly as possible across the doc.
    step = len(rows) / cap
    return [rows[int(i * step)] for i in range(cap)]


# ── LLM call ─────────────────────────────────────────────────────────────────


_SYSTEM = (
    "You are a document structure extractor. You will be given short previews "
    "of consecutive chunks from one document, each tagged with an index and a "
    "page number. Your job is to add navigation tags so a student can later "
    "jump to a chapter or topic.\n\n"
    "Rules:\n"
    "- Output STRICT JSON: {\"assignments\": [{\"idx\": int, \"chapter\": int|null, "
    "\"section\": string|null}, ...]}\n"
    "- ``chapter``: integer chapter/lecture/unit number ONLY when explicitly "
    "stated in the chunk (e.g. 'Chapter 4', 'Lecture 2', 'Unit 3'). Null otherwise. "
    "Be strict — do not invent chapter numbers.\n"
    "- ``section``: a short 2-5 word topic label for the chunk. Emit one whenever "
    "the chunk has a recognisable topic, even if no chapter number exists. For a "
    "lecture transcript or YouTube video this might be 'Introduction', "
    "'Comparing CNN architectures', 'Loss function intuition' — describe what "
    "the chunk is ABOUT in plain English. Null only when the chunk is truly "
    "filler (greetings, acknowledgements, dead air).\n"
    "- If consecutive chunks discuss the same topic, repeat the section label — "
    "the boundary matters less than each chunk having a tag students can "
    "filter by.\n"
    "- Do not include chunks you can't classify; just emit null fields.\n"
    "- Output only the JSON. No prose, no markdown fence."
)


async def _ask_llm(
    provider: LLMProvider,
    model: str,
    sample: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    user_blocks: list[str] = []
    for idx, row in enumerate(sample):
        page = row.get("page")
        content = (row.get("content") or "").strip()
        preview = content[:_PREVIEW_CHARS]
        page_str = f"p.{page}" if page is not None else "p.-"
        user_blocks.append(f"[{idx}] ({page_str}) {preview}")
    user_msg = (
        "Document chunks:\n\n"
        + "\n\n".join(user_blocks)
        + "\n\nReturn the JSON now."
    )
    res = await provider.complete(
        LLMRequest(
            model=model,
            messages=[
                ChannelMessage(role="system", content=_SYSTEM),
                ChannelMessage(role="user", content=user_msg),
            ],
            max_output_tokens=2048,
            temperature=0.1,
        )
    )
    parsed = _parse_assignments(res.text)
    return parsed


def _parse_assignments(text: str) -> list[dict[str, Any]]:
    # Tolerate models that wrap in code fences despite our instruction.
    cleaned = text.strip()
    fence = re.search(r"\{[\s\S]*\}", cleaned)
    if fence:
        cleaned = fence.group(0)
    try:
        obj = json.loads(cleaned)
    except json.JSONDecodeError as exc:
        raise ValueError(f"LLM returned non-JSON: {exc}") from exc
    raw = obj.get("assignments")
    if not isinstance(raw, list):
        raise ValueError("LLM JSON missing 'assignments' array")
    out: list[dict[str, Any]] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        idx = item.get("idx")
        if not isinstance(idx, int):
            continue
        chapter = item.get("chapter")
        section = item.get("section")
        if chapter is not None and not isinstance(chapter, int):
            chapter = None
        if section is not None and not isinstance(section, str):
            section = None
        out.append({"idx": idx, "chapter": chapter, "section": section})
    return out


# ── DB backfill ──────────────────────────────────────────────────────────────


async def _backfill(
    pool: AsyncConnectionPool,
    sample: list[dict[str, Any]],
    assignments: list[dict[str, Any]],
) -> tuple[int, int, int]:
    """Returns ``(rows_updated, distinct_chapters_seen, distinct_sections_seen)``.

    Only writes chunks that don't already have a ``chapter`` (or have
    only ``contentType`` from the regex pass). We never override a
    regex-derived chapter — it came from explicit heading text and is
    more reliable than the LLM's inference from a 220-char preview.
    """
    updated = 0
    chapters: set[int] = set()
    sections: set[str] = set()
    # Explicit casts on both args. ``jsonb_build_object`` accepts
    # ``anyelement`` for its value positions, so a bare placeholder
    # leaves psycopg unable to infer the type when the bound value is
    # NULL — Postgres raises IndeterminateDatatype on the second param.
    sql = """
        UPDATE "Chunk"
           SET meta = COALESCE(meta, '{}'::jsonb)
                      || jsonb_build_object(
                           'chapter', %(chapter)s::int,
                           'section', %(section)s::text
                         )
         WHERE id = %(id)s::uuid
           AND (
             meta IS NULL
             OR (meta->>'chapter') IS NULL
           )
    """
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            for assignment in assignments:
                idx = assignment["idx"]
                if not (0 <= idx < len(sample)):
                    continue
                row = sample[idx]
                chapter = assignment["chapter"]
                section = assignment["section"]
                if chapter is None and section is None:
                    continue
                await cur.execute(
                    sql,
                    {
                        "id": str(row["id"]),
                        "chapter": chapter,
                        "section": section,
                    },
                )
                if cur.rowcount > 0:
                    updated += 1
                    if isinstance(chapter, int):
                        chapters.add(chapter)
                    if isinstance(section, str) and section.strip():
                        sections.add(section.strip().lower())
        await conn.commit()
    return updated, len(chapters), len(sections)


__all__ = ["DeepIndexRequest", "DeepIndexResponse", "build_router"]
