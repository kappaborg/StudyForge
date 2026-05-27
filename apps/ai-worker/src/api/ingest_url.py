"""POST /v1/ingest/url — non-file ingest sources.

Currently handles YouTube URLs via ``youtube-transcript-api``. The captions
land as plain text, get synthesised into an ``IngestRequest`` with
``mime='text/plain'`` and ``bytes=<transcript>``, and ride the rest of
the existing pipeline (safety pass → chunker → store → embed). The end
result is a normal ``Document`` row in the user's folder; downstream
features (RAG retrieval, flashcards, scopes) don't have to know the
source was a video.

Why no S3 round-trip? Captions are tiny (kBs), already structured, and
re-fetching them is free if we ever need the "raw bytes" again. Pushing
them through MinIO just to satisfy the upload flow's contract would add
two needless network hops.
"""

from __future__ import annotations

import logging
import re
from typing import Literal
from urllib.parse import parse_qs, urlparse
from xml.etree.ElementTree import ParseError as XmlParseError

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from psycopg_pool import AsyncConnectionPool

from ..ingest import IngestRequest, PostgresIngestStore, ingest_document
from ..rag.embed_writer import embed_pending_chunks
from ..rag.retriever import Embedder

log = logging.getLogger(__name__)


class IngestUrlRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    tenant_id: str
    user_id: str
    course_id: str | None = None
    folder_id: str | None = None
    upload_batch_id: str
    url: str = Field(min_length=8, max_length=2048)
    source: Literal["youtube"] = "youtube"
    language_hints: list[str] = Field(default_factory=lambda: ["en", "en-US", "en-GB"])


class IngestUrlResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    document_id: str
    document_version_id: str
    chunk_count: int
    embedded_chunks: int
    title: str
    transcript_chars: int


class IngestTextRequest(BaseModel):
    """Direct text payload — used by the browser extension to ingest
    "the article I'm reading" or a copied selection without going
    through S3 or the YouTube path."""

    model_config = ConfigDict(extra="forbid")

    tenant_id: str
    user_id: str
    course_id: str | None = None
    folder_id: str | None = None
    upload_batch_id: str
    title: str = Field(min_length=1, max_length=400)
    text: str = Field(min_length=1, max_length=2_000_000)
    # Optional source URL preserved on the synthetic ``s3_key`` so a
    # future "open original" affordance has something to link to.
    source_url: str | None = None


class IngestTextResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    document_id: str
    document_version_id: str
    chunk_count: int
    embedded_chunks: int
    title: str
    text_chars: int


# ── YouTube helpers ─────────────────────────────────────────────────────────

_YOUTUBE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")

# YouTube's public oEmbed endpoint. Returns ``title``, ``author_name``, and a
# few other fields for any public, embeddable video. No API key, no quota in
# practice. Private / age-gated / deleted videos return 401 / 404 — in that
# case we silently fall back to the synthetic ``YouTube · {video_id}`` title.
_OEMBED_URL = "https://www.youtube.com/oembed"
_OEMBED_TIMEOUT_S = 4.0
# Hard cap on the title length we'll store. Real titles top out near 100
# chars; the upper bound here just prevents pathological inputs from
# bloating the originalFilename column.
_MAX_TITLE_LEN = 200


async def _fetch_youtube_title(video_id: str) -> str | None:
    """Best-effort title lookup via the public oEmbed endpoint. Returns
    ``None`` on any error so the caller can fall back to a synthetic title.
    Strips control characters and caps length so the result is safe to use
    as a document filename.
    """
    url = f"https://www.youtube.com/watch?v={video_id}"
    try:
        async with httpx.AsyncClient(timeout=_OEMBED_TIMEOUT_S) as client:
            resp = await client.get(_OEMBED_URL, params={"url": url, "format": "json"})
        if resp.status_code != 200:
            return None
        data = resp.json()
    except Exception as exc:  # noqa: BLE001 — title lookup is best-effort
        log.info("youtube.oembed_failed video_id=%s err=%s", video_id, exc)
        return None
    title = data.get("title")
    if not isinstance(title, str):
        return None
    cleaned = "".join(ch for ch in title if ch.isprintable()).strip()
    if not cleaned:
        return None
    return cleaned[:_MAX_TITLE_LEN]


def _extract_youtube_id(url: str) -> str | None:
    """Tolerant URL parser. Accepts youtu.be/<id>, /watch?v=<id>,
    /shorts/<id>, /embed/<id>, or a bare 11-char id."""
    s = url.strip()
    if _YOUTUBE_ID_RE.match(s):
        return s
    try:
        parsed = urlparse(s)
    except ValueError:
        return None
    host = (parsed.hostname or "").lower()
    if host.endswith("youtu.be"):
        candidate = parsed.path.lstrip("/")
        return candidate if _YOUTUBE_ID_RE.match(candidate) else None
    if "youtube.com" in host or "youtube-nocookie.com" in host:
        if parsed.path.startswith("/watch"):
            qs = parse_qs(parsed.query)
            cand = (qs.get("v") or [""])[0]
            return cand if _YOUTUBE_ID_RE.match(cand) else None
        for prefix in ("/shorts/", "/embed/", "/v/"):
            if parsed.path.startswith(prefix):
                cand = parsed.path[len(prefix) :].split("/")[0]
                return cand if _YOUTUBE_ID_RE.match(cand) else None
    return None


def _fetch_youtube_transcript(video_id: str, languages: list[str]) -> tuple[str, str]:
    """Returns ``(transcript_text, derived_title)``. Raises ``HTTPException``
    with a 4xx code on user-visible failures (no captions, invalid id, etc).

    The library doesn't expose the video title in transcript responses, so
    we synthesise one from the id; the API gateway can override it with a
    user-supplied title later.
    """
    # Imported lazily so the worker boot doesn't pull the package when
    # YouTube ingest is never used.
    from youtube_transcript_api import YouTubeTranscriptApi
    from youtube_transcript_api._errors import (
        NoTranscriptFound,
        TranscriptsDisabled,
        VideoUnavailable,
    )

    api = YouTubeTranscriptApi()
    try:
        transcript_list = api.list(video_id)
    except TranscriptsDisabled:
        raise HTTPException(status_code=400, detail="This video has captions disabled.")
    except VideoUnavailable:
        raise HTTPException(status_code=404, detail="Video is unavailable.")
    except XmlParseError:
        raise HTTPException(status_code=400, detail="Could not parse YouTube transcript response.")
    except Exception as exc:  # noqa: BLE001
        log.exception("youtube.list_failed video_id=%s", video_id)
        raise HTTPException(status_code=502, detail=f"YouTube fetch failed: {exc}") from exc

    # Prefer manually-created captions in the requested languages; fall back
    # to auto-generated; finally fall back to the first transcript we can find
    # at all.
    transcript = None
    try:
        transcript = transcript_list.find_manually_created_transcript(languages)
    except NoTranscriptFound:
        try:
            transcript = transcript_list.find_generated_transcript(languages)
        except NoTranscriptFound:
            transcripts = list(transcript_list)
            if transcripts:
                transcript = transcripts[0]
    if transcript is None:
        raise HTTPException(
            status_code=400,
            detail=(
                "No usable captions on this video. Try a different video or wait — "
                "YouTube sometimes generates captions late."
            ),
        )

    try:
        fetched = transcript.fetch()
    except XmlParseError:
        raise HTTPException(status_code=400, detail="Could not parse YouTube transcript response.")
    except Exception as exc:  # noqa: BLE001
        log.exception("youtube.fetch_failed video_id=%s", video_id)
        raise HTTPException(status_code=502, detail=f"YouTube transcript fetch failed: {exc}") from exc

    # Each snippet has ``text``, ``start``, ``duration``. We collapse to a
    # plain paragraph stream because the chunker is already heading-aware
    # and will produce reasonable text chunks. Timestamps could light up a
    # "jump to 4:32" feature later but aren't load-bearing for retrieval.
    text_parts: list[str] = []
    for snippet in fetched:
        text = snippet.text.strip() if hasattr(snippet, "text") else str(snippet).strip()
        if text:
            text_parts.append(text)
    transcript_text = " ".join(text_parts)
    if not transcript_text:
        raise HTTPException(status_code=400, detail="YouTube returned an empty transcript.")

    derived_title = f"YouTube · {video_id}"
    return transcript_text, derived_title


# ── HTTP surface ────────────────────────────────────────────────────────────


def build_router(
    *, dsn: str, pool: AsyncConnectionPool, embedder: Embedder
) -> APIRouter:
    router = APIRouter(prefix="/v1/ingest", tags=["ingest"])

    @router.post("/url", response_model=IngestUrlResponse)
    async def ingest_url(req: IngestUrlRequest) -> IngestUrlResponse:
        if req.source != "youtube":
            raise HTTPException(status_code=400, detail=f"Unsupported source: {req.source}")
        video_id = _extract_youtube_id(req.url)
        if not video_id:
            raise HTTPException(status_code=400, detail="Could not parse YouTube URL.")

        transcript_text, fallback_title = _fetch_youtube_transcript(
            video_id, req.language_hints
        )
        # Prefer the real video title from oEmbed; fall back to the synthetic
        # ``YouTube · {video_id}`` if oEmbed is unavailable for this video
        # (private, age-gated, deleted, or rate-limited).
        oembed_title = await _fetch_youtube_title(video_id)
        title = oembed_title or fallback_title

        log.info(
            "ingest.url.fetched source=youtube video_id=%s chars=%d title_source=%s",
            video_id,
            len(transcript_text),
            "oembed" if oembed_title else "fallback",
        )

        # The pipeline expects file bytes + a mime. We re-use the plaintext
        # path — the chunker has heading-aware splitting, but a contiguous
        # caption stream just becomes one or two sliding-window chunks,
        # which is exactly what we want for short videos.
        body = transcript_text.encode("utf-8")
        store = PostgresIngestStore(dsn)
        try:
            result = await ingest_document(
                IngestRequest(
                    tenant_id=req.tenant_id,
                    course_id=req.course_id,
                    folder_id=req.folder_id,
                    upload_batch_id=req.upload_batch_id,
                    mime="text/plain",
                    original_filename=f"{title}.txt",
                    s3_key=f"youtube://{video_id}",
                    bytes=body,
                ),
                store,
            )
        finally:
            await store.aclose()

        # Embeddings for the freshly-written chunks (same step the regular
        # ingest agent runs after parse).
        embed_outcome = await embed_pending_chunks(
            pool=pool,
            embedder=embedder,
            document_version_id=result.document_version_id,
        )

        return IngestUrlResponse(
            document_id=result.document_id,
            document_version_id=result.document_version_id,
            chunk_count=result.chunk_count,
            embedded_chunks=embed_outcome.chunks_embedded,
            title=title,
            transcript_chars=len(transcript_text),
        )

    @router.post("/text", response_model=IngestTextResponse)
    async def ingest_text(req: IngestTextRequest) -> IngestTextResponse:
        """Plain-text ingest. Used by the browser extension to capture a
        webpage, article, or selection. The text is treated identically
        to a small TXT upload — same chunker, same safety pass, same
        retrieval-after-embedding.

        The synthetic ``s3_key`` carries the source URL when provided so
        the document detail UI can offer an "open original" link without
        a separate metadata field.
        """
        store = PostgresIngestStore(dsn)
        try:
            result = await ingest_document(
                IngestRequest(
                    tenant_id=req.tenant_id,
                    course_id=req.course_id,
                    folder_id=req.folder_id,
                    upload_batch_id=req.upload_batch_id,
                    mime="text/plain",
                    original_filename=f"{req.title}.txt",
                    s3_key=req.source_url or f"text://{req.upload_batch_id}",
                    bytes=req.text.encode("utf-8"),
                ),
                store,
            )
        finally:
            await store.aclose()

        embed_outcome = await embed_pending_chunks(
            pool=pool,
            embedder=embedder,
            document_version_id=result.document_version_id,
        )

        return IngestTextResponse(
            document_id=result.document_id,
            document_version_id=result.document_version_id,
            chunk_count=result.chunk_count,
            embedded_chunks=embed_outcome.chunks_embedded,
            title=req.title,
            text_chars=len(req.text),
        )

    return router


__all__ = [
    "build_router",
    "IngestUrlRequest",
    "IngestUrlResponse",
    "IngestTextRequest",
    "IngestTextResponse",
]
