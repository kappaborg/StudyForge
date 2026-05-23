"""RAG core for StudyForge AI.

A single retrieval orchestrator that hybrid-retrieves (dense + sparse), fuses
ranks via RRF, reranks, and emits citation-ready chunks. Every agent that needs
grounded context consumes ``Retriever.retrieve``.
"""

from .contracts import (
    Candidate as Candidate,
    MetadataFilter as MetadataFilter,
    RetrievalRequest as RetrievalRequest,
    RetrievalResult as RetrievalResult,
    RetrievalTelemetry as RetrievalTelemetry,
    RetrievedChunk as RetrievedChunk,
)
from .embed_writer import (
    EmbedJobResult as EmbedJobResult,
    embed_pending_chunks as embed_pending_chunks,
)
from .embedder import (
    BgeM3Embedder as BgeM3Embedder,
    EMBEDDING_DIM as EMBEDDING_DIM,
    FastEmbedEmbedder as FastEmbedEmbedder,
    StubEmbedder as StubEmbedder,
)
from .fusion import reciprocal_rank_fusion as reciprocal_rank_fusion
from .postgres import (
    PgvectorDenseRetriever as PgvectorDenseRetriever,
    PostgresChunkResolver as PostgresChunkResolver,
    TsvectorSparseRetriever as TsvectorSparseRetriever,
    build_postgres_backends as build_postgres_backends,
)
from .reranker import (
    BgeReranker as BgeReranker,
    IdentityReranker as IdentityReranker,
)
from .retriever import Retriever as Retriever
