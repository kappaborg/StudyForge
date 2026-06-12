"""RAG core for StudyForge AI.

A single retrieval orchestrator that hybrid-retrieves (dense + sparse), fuses
ranks via RRF, reranks, and emits citation-ready chunks. Every agent that needs
grounded context consumes ``Retriever.retrieve``.
"""

from .contracts import (
    Candidate as Candidate,
)
from .contracts import (
    MetadataFilter as MetadataFilter,
)
from .contracts import (
    RetrievalRequest as RetrievalRequest,
)
from .contracts import (
    RetrievalResult as RetrievalResult,
)
from .contracts import (
    RetrievalTelemetry as RetrievalTelemetry,
)
from .contracts import (
    RetrievedChunk as RetrievedChunk,
)
from .embed_writer import (
    EmbedJobResult as EmbedJobResult,
)
from .embed_writer import (
    embed_pending_chunks as embed_pending_chunks,
)
from .embedder import (
    EMBEDDING_DIM as EMBEDDING_DIM,
)
from .embedder import (
    BgeM3Embedder as BgeM3Embedder,
)
from .embedder import (
    FastEmbedEmbedder as FastEmbedEmbedder,
)
from .embedder import (
    StubEmbedder as StubEmbedder,
)
from .fusion import reciprocal_rank_fusion as reciprocal_rank_fusion
from .postgres import (
    PgvectorDenseRetriever as PgvectorDenseRetriever,
)
from .postgres import (
    PostgresChunkResolver as PostgresChunkResolver,
)
from .postgres import (
    TsvectorSparseRetriever as TsvectorSparseRetriever,
)
from .postgres import (
    build_postgres_backends as build_postgres_backends,
)
from .reranker import (
    BgeReranker as BgeReranker,
)
from .reranker import (
    IdentityReranker as IdentityReranker,
)
from .retriever import Retriever as Retriever
