"""Persistence boundary for the ingest pipeline.

Two implementations:

  * ``InMemoryIngestStore`` — used by tests and the dev loop when Postgres
    isn't reachable. Behaves identically to the real store for the small set
    of mutations the pipeline needs.
  * ``PostgresIngestStore`` — psycopg-based writer that inserts directly into
    the ``Document`` / ``DocumentVersion`` / ``Chunk`` tables from
    Deliverable 3. The column quoting matches Prisma's camelCase convention.

The pipeline takes whichever ``IngestStore`` it is handed; nothing else cares.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Protocol
from uuid import UUID, uuid4

from ..rag.chunker import Chunk


@dataclass(frozen=True)
class DocumentRow:
    id: str
    tenant_id: str
    course_id: str | None
    folder_id: str | None
    upload_batch_id: str
    mime: str
    original_filename: str
    s3_key: str
    page_count: int | None
    language: str | None


@dataclass(frozen=True)
class DocumentVersionRow:
    id: str
    document_id: str
    version_number: int
    content_sha256: str
    bytes_sha256: str


@dataclass(frozen=True)
class WrittenChunk:
    id: str
    document_version_id: str
    ordinal: int


class IngestStore(Protocol):
    async def write_document(self, row: DocumentRow) -> str: ...
    async def write_document_version(self, row: DocumentVersionRow) -> str: ...
    async def write_chunks(
        self, *, document_version_id: str, chunks: list[Chunk]
    ) -> list[WrittenChunk]: ...


# ─────────────────────────────────────────────────────────────────────────────
# In-memory
# ─────────────────────────────────────────────────────────────────────────────


class InMemoryIngestStore(IngestStore):
    def __init__(self) -> None:
        self.documents: list[DocumentRow] = []
        self.versions: list[DocumentVersionRow] = []
        self.chunks: list[tuple[WrittenChunk, Chunk]] = []

    async def write_document(self, row: DocumentRow) -> str:
        self.documents.append(row)
        return row.id

    async def write_document_version(self, row: DocumentVersionRow) -> str:
        self.versions.append(row)
        return row.id

    async def write_chunks(
        self, *, document_version_id: str, chunks: list[Chunk]
    ) -> list[WrittenChunk]:
        written: list[WrittenChunk] = []
        for chunk in chunks:
            entry = WrittenChunk(
                id=str(uuid4()),
                document_version_id=document_version_id,
                ordinal=chunk.ordinal,
            )
            self.chunks.append((entry, chunk))
            written.append(entry)
        return written


# ─────────────────────────────────────────────────────────────────────────────
# Postgres
# ─────────────────────────────────────────────────────────────────────────────


class PostgresIngestStore(IngestStore):
    """Async writer. Uses psycopg3 with a connection pool opened lazily on
    first use. Tables and column names follow Prisma's camelCase convention.
    """

    def __init__(self, dsn: str, *, min_size: int = 1, max_size: int = 4) -> None:
        self._dsn = dsn
        self._min_size = min_size
        self._max_size = max_size
        self._pool: object | None = None  # AsyncConnectionPool — typed loosely
        # to avoid importing psycopg at module-load time in environments where
        # psycopg's binary wheel isn't present.

    async def _ensure_pool(self) -> object:
        if self._pool is None:
            from psycopg_pool import AsyncConnectionPool

            pool = AsyncConnectionPool(
                self._dsn,
                min_size=self._min_size,
                max_size=self._max_size,
                open=False,
            )
            await pool.open()
            self._pool = pool
        return self._pool

    async def aclose(self) -> None:
        if self._pool is not None:
            await self._pool.close()  # type: ignore[attr-defined]
            self._pool = None

    async def write_document(self, row: DocumentRow) -> str:
        pool = await self._ensure_pool()
        async with pool.connection() as conn:  # type: ignore[attr-defined]
            await conn.execute(
                """
                INSERT INTO "Document" (
                  id, "tenantId", "courseId", "folderId", "uploadBatchId",
                  mime, "originalFilename", "s3Key",
                  "pageCount", language, "updatedAt"
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, now())
                """,
                (
                    row.id,
                    row.tenant_id,
                    row.course_id,
                    row.folder_id,
                    row.upload_batch_id,
                    row.mime,
                    row.original_filename,
                    row.s3_key,
                    row.page_count,
                    row.language,
                ),
            )
        return row.id

    async def write_document_version(self, row: DocumentVersionRow) -> str:
        pool = await self._ensure_pool()
        async with pool.connection() as conn:  # type: ignore[attr-defined]
            await conn.execute(
                """
                INSERT INTO "DocumentVersion" (
                  id, "documentId", "versionNumber", "contentSha256", "bytesSha256"
                )
                VALUES (%s, %s, %s, %s, %s)
                """,
                (
                    row.id,
                    row.document_id,
                    row.version_number,
                    row.content_sha256,
                    row.bytes_sha256,
                ),
            )
        return row.id

    async def write_chunks(
        self, *, document_version_id: str, chunks: list[Chunk]
    ) -> list[WrittenChunk]:
        pool = await self._ensure_pool()
        written: list[WrittenChunk] = []
        async with pool.connection() as conn:  # type: ignore[attr-defined]
            async with conn.transaction():
                async with conn.cursor() as cur:
                    for chunk in chunks:
                        chunk_id = str(uuid4())
                        await cur.execute(
                            """
                            INSERT INTO "Chunk" (
                              id, "documentVersionId", ordinal, modality,
                              page, slide, cell, "charStart", "charEnd",
                              content, meta
                            )
                            VALUES (
                              %s, %s, %s, %s::"ChunkModality",
                              %s, %s, %s, %s, %s,
                              %s, %s::jsonb
                            )
                            """,
                            (
                                chunk_id,
                                document_version_id,
                                chunk.ordinal,
                                chunk.modality.value,
                                chunk.page,
                                chunk.slide,
                                chunk.cell,
                                chunk.char_start,
                                chunk.char_end,
                                chunk.content,
                                json.dumps({
                                    **chunk.meta,
                                    "heading_path": list(chunk.heading_path),
                                }),
                            ),
                        )
                        written.append(
                            WrittenChunk(
                                id=chunk_id,
                                document_version_id=document_version_id,
                                ordinal=chunk.ordinal,
                            )
                        )
        return written


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────


def is_valid_uuid(s: str) -> bool:
    try:
        UUID(s)
        return True
    except ValueError:
        return False
