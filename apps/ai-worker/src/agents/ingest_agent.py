"""End-to-end ingest agent.

Wraps the existing PyMuPDF → safety → chunk → persist pipeline + the
embedding writer behind a single agent the gateway can fire after an upload
completes. Avoids stitching four agent calls across the HTTP boundary.

Fetches the file bytes from S3 (MinIO in dev) using settings.s3_*. Persists
via the production ``PostgresIngestStore``. Writes embeddings via
``StubEmbedder`` in Phase 1 (BGE-M3 swap-in is a one-line change in
``main.py`` once the model is wired).
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass

from psycopg_pool import AsyncConnectionPool

from ..ingest import IngestRequest, PostgresIngestStore, ingest_document
from ..ingest.s3 import S3Config, build_s3_client, fetch_bytes
from ..rag.embed_writer import embed_pending_chunks
from ..rag.retriever import Embedder
from ..settings import Settings
from .contracts import (
    IngestProcessInput,
    IngestProcessOutput,
)

log = logging.getLogger(__name__)


@dataclass
class IngestAgentDeps:
    dsn: str
    pool: AsyncConnectionPool
    embedder: Embedder
    s3: S3Config


class IngestAgent:
    """Implements the ``Agent`` protocol structurally."""

    name = "ingest.process.v1"
    version = "0.1.0"
    input_model = IngestProcessInput
    output_model = IngestProcessOutput

    def __init__(self, deps: IngestAgentDeps) -> None:
        self._deps = deps

    async def run(self, payload: IngestProcessInput) -> IngestProcessOutput:
        # 1. Fetch file bytes from S3. boto3 is sync, so we run it on a thread
        #    to keep the event loop free.
        client = build_s3_client(self._deps.s3)
        file_bytes = await asyncio.to_thread(
            fetch_bytes, client, bucket=self._deps.s3.bucket, key=payload.s3_key
        )
        log.info(
            "ingest.fetched",
            extra={
                "size_bytes": len(file_bytes),
                "s3_key": payload.s3_key,
                "upload_batch": payload.upload_batch_id,
            },
        )

        # 2. Parse + safety + chunk + persist.
        store = PostgresIngestStore(self._deps.dsn)
        try:
            result = await ingest_document(
                IngestRequest(
                    tenant_id=payload.tenant_id,
                    course_id=payload.course_id,
                    folder_id=payload.folder_id,
                    upload_batch_id=payload.upload_batch_id,
                    mime=payload.mime,
                    original_filename=payload.original_filename,
                    s3_key=payload.s3_key,
                    bytes=file_bytes,
                ),
                store,
            )
        finally:
            await store.aclose()

        # 3. Fill embeddings for the freshly-written chunks.
        embed_outcome = await embed_pending_chunks(
            pool=self._deps.pool,
            embedder=self._deps.embedder,
            document_version_id=result.document_version_id,
        )

        log.info(
            "ingest.complete",
            extra={
                "document_id": result.document_id,
                "document_version_id": result.document_version_id,
                "chunks": result.chunk_count,
                "embedded": embed_outcome.chunks_embedded,
                "safety_flags": [f.value for f in result.safety_flags],
            },
        )

        return IngestProcessOutput(
            document_id=result.document_id,
            document_version_id=result.document_version_id,
            chunk_count=result.chunk_count,
            page_count=result.page_count,
            embedded_chunk_count=embed_outcome.chunks_embedded,
            bytes_sha256=result.bytes_sha256,
            content_sha256=result.content_sha256,
            safety_flags=list(result.safety_flags),
        )


def build_default_ingest_agent(settings: Settings, pool: AsyncConnectionPool) -> IngestAgent:
    from ..rag.factory import build_embedder

    deps = IngestAgentDeps(
        dsn=settings.database_url,
        pool=pool,
        embedder=build_embedder(settings),
        s3=S3Config(
            endpoint_url=settings.s3_endpoint,
            region=settings.s3_region,
            access_key=settings.s3_access_key,
            secret_key=settings.s3_secret_key,
            bucket=settings.s3_bucket,
            force_path_style=True,
        ),
    )
    return IngestAgent(deps)
