"""RAG Pydantic contracts.

These types are the boundary between the retrieval orchestrator and its
consumers (agents, evals, the gateway). The ``RetrievedChunk`` shape is
identical to the agent contract in ``src.agents.contracts`` — citation data
flows from retrieval straight into agent inputs without translation.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Annotated, Any

from pydantic import BaseModel, ConfigDict, Field, NonNegativeInt


class RetrieverKind(StrEnum):
    dense = "dense"
    sparse = "sparse"
    kg = "kg"


class Candidate(BaseModel):
    """A single ranked candidate from one underlying retriever."""

    model_config = ConfigDict(extra="forbid")

    chunk_id: str
    rank: NonNegativeInt
    score: float
    kind: RetrieverKind


class RetrievedChunk(BaseModel):
    """Mirror of ``src.agents.contracts.RetrievedChunk``. Kept in this module
    so the RAG layer has no upward import of the agents package."""

    model_config = ConfigDict(extra="forbid")

    chunk_id: str
    doc_id: str
    version_id: str
    page: int | None = None
    slide: int | None = None
    cell: int | None = None
    char_start: NonNegativeInt
    char_end: NonNegativeInt
    score: Annotated[float, Field(ge=0.0, le=1.0)]
    content: str
    modality: str = "text"
    heading_path: list[str] = Field(default_factory=list)


class MetadataFilter(BaseModel):
    """Server-side filter pushed into both dense and sparse queries."""

    model_config = ConfigDict(extra="forbid")

    document_ids: list[str] | None = None
    modalities: list[str] | None = None
    min_freshness_iso: str | None = None


class RetrievalRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    tenant_id: str
    course_id: str | None = None
    folder_id: str | None = None
    # Exam-scope filter: when set, only chunks whose ``meta.chapter`` value
    # is in this list are eligible. Empty / unset means no chapter filter.
    chapters: list[int] | None = None
    # Read-access escape hatch for instructor-shared folders. Chunks in
    # these folders are eligible EVEN IF they belong to a different
    # tenant — the API gateway computes this list per user from their
    # FolderSubscription rows. The base tenantId still applies for the
    # user's own materials; this is OR-ed in, not AND-ed.
    allowed_folder_ids: list[str] | None = None
    query: str = Field(min_length=1, max_length=8_000)
    k: Annotated[int, Field(ge=1, le=50)] = 5
    fusion_k: Annotated[int, Field(ge=1, le=200)] = 60
    candidates_per_retriever: Annotated[int, Field(ge=1, le=200)] = 20
    metadata_filter: MetadataFilter | None = None


class RetrievalTelemetry(BaseModel):
    model_config = ConfigDict(extra="forbid")

    dense_candidates: int = 0
    sparse_candidates: int = 0
    fused_candidates: int = 0
    reranked_returned: int = 0
    semantic_cache_hit: bool = False
    exact_cache_hit: bool = False
    kg_expanded: bool = False
    dense_latency_ms: int = 0
    sparse_latency_ms: int = 0
    rerank_latency_ms: int = 0
    total_latency_ms: int = 0


class RetrievalResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    chunks: list[RetrievedChunk]
    telemetry: RetrievalTelemetry
    diagnostics: dict[str, Any] = Field(default_factory=dict)
