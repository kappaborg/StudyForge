"""Pydantic contracts for every agent in the pipeline.

Each agent has exactly one ``Input`` model and one ``Output`` model. Mismatched
schemas raise at the boundary, never inside an agent. Schemas are versioned via
the agent prompt id (``tutor.answer.v1``); changing a contract means bumping
that version and providing a golden-set eval.

These types are also the wire format for the orchestrator's run payloads —
serialised as JSON, stored on the ``Job`` row, replayed on retry.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, NonNegativeInt

# Constrained-type aliases. We use Annotated rather than Pydantic's runtime
# helpers (conint / conlist) so mypy in strict mode can analyse them.
JsonDict = dict[str, Any]
DifficultyScore = Annotated[int, Field(ge=0, le=100)]
WeekIndex = Annotated[int, Field(ge=0)]
PositiveInt = Annotated[int, Field(ge=1)]
WeeksHorizon = Annotated[int, Field(ge=1, le=52)]
ItemCount = Annotated[int, Field(ge=1, le=50)]
MaxAttempts = Annotated[int, Field(ge=1, le=10)]
HorizonHours = Annotated[int, Field(ge=1, le=168)]
Score01 = Annotated[float, Field(ge=0.0, le=1.0)]
BlockRefList = Annotated[list[int], Field(min_length=1)]
ConceptList = Annotated[list["Concept"], Field(min_length=1)]
ConceptIdList = Annotated[list[str], Field(min_length=1)]
EdgesList = Annotated[list["ConceptEdge"], Field(max_length=10_000)]
CitationsList = Annotated[list["Citation"], Field(min_length=1)]

# ─────────────────────────────────────────────────────────────────────────────
# Shared primitives
# ─────────────────────────────────────────────────────────────────────────────


class ChunkModality(StrEnum):
    text = "text"
    code = "code"
    table = "table"
    formula = "formula"
    image_ocr = "image_ocr"
    slide = "slide"
    notebook_cell = "notebook_cell"


class ConceptEdgeKind(StrEnum):
    prerequisite_of = "prerequisite_of"
    related_to = "related_to"
    example_of = "example_of"
    derived_from = "derived_from"
    contradicts = "contradicts"


class Citation(BaseModel):
    """A single citation pointing at the source chunk that supports a claim."""

    model_config = ConfigDict(extra="forbid")

    chunk_id: str
    doc_id: str
    version_id: str
    page: int | None = None
    slide: int | None = None
    cell: int | None = None
    char_start: NonNegativeInt
    char_end: NonNegativeInt
    score: float = Field(ge=0.0, le=1.0)


class Block(BaseModel):
    """Output of the Document Parser. Modality-tagged content with spans."""

    model_config = ConfigDict(extra="forbid")

    modality: ChunkModality
    text: str
    page: int | None = None
    slide: int | None = None
    cell: int | None = None
    char_start: NonNegativeInt = 0
    char_end: NonNegativeInt = 0
    meta: JsonDict = Field(default_factory=dict)


class ContentChannel(StrEnum):
    """Where content originated, for prompt-injection defence."""

    system = "system"
    tool = "tool"
    trusted_user = "trusted_user"
    untrusted_document = "untrusted_document"


# ─────────────────────────────────────────────────────────────────────────────
# 1. Document Parser
# ─────────────────────────────────────────────────────────────────────────────


class DocumentParserInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    document_id: str
    s3_key: str
    mime: str
    original_filename: str


class DocumentParserOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    document_id: str
    page_count: int | None = None
    language: str | None = None
    blocks: list[Block]


# End-to-end "fetch from S3 → parse → safety → chunk → embed → persist". The
# gateway invokes this single agent after a successful upload — no need to
# chain four agent calls across the wire.


class IngestProcessInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    tenant_id: str
    course_id: str | None = None
    folder_id: str | None = None
    upload_batch_id: str
    mime: str
    original_filename: str
    s3_key: str


class IngestProcessOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    document_id: str
    document_version_id: str
    chunk_count: int
    page_count: int
    embedded_chunk_count: int
    bytes_sha256: str
    content_sha256: str
    safety_flags: list[SafetyFlag] = Field(default_factory=list)


# ─────────────────────────────────────────────────────────────────────────────
# 2. Safety / PII
# ─────────────────────────────────────────────────────────────────────────────


class SafetyFlag(StrEnum):
    pii_redacted = "pii_redacted"
    prompt_injection_suspected = "prompt_injection_suspected"
    moderation_high_risk = "moderation_high_risk"
    copyright_suspected = "copyright_suspected"


class SanitizedBlock(Block):
    channel: ContentChannel
    injection_score: float = Field(ge=0.0, le=1.0)
    redaction_tokens: JsonDict = Field(default_factory=dict)


class SafetyInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    document_id: str
    blocks: list[Block]


class SafetyOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    document_id: str
    blocks: list[SanitizedBlock]
    flags: list[SafetyFlag] = Field(default_factory=list)
    quarantined: bool = False


# ─────────────────────────────────────────────────────────────────────────────
# 3. Semantic Analyzer
# ─────────────────────────────────────────────────────────────────────────────


class Concept(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    label: str
    description: str | None = None
    difficulty: DifficultyScore = 0
    block_refs: BlockRefList
    """Indices into the input ``blocks`` array. Every concept must cite at
    least one source block."""


class ConceptEdge(BaseModel):
    model_config = ConfigDict(extra="forbid")

    from_id: str
    to_id: str
    kind: ConceptEdgeKind
    weight: float = Field(default=1.0, ge=0.0, le=1.0)


class ConceptTree(BaseModel):
    model_config = ConfigDict(extra="forbid")

    concepts: list[Concept]
    edges: list[ConceptEdge] = Field(default_factory=list)


class SemanticAnalyzerInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    document_id: str
    blocks: list[SanitizedBlock]


class SemanticAnalyzerFromChunksInput(BaseModel):
    """Phase-2 chunk-driven entrypoint.

    Runs against chunks already retrieved from a course's corpus and emits
    concept nodes + edges that the API persists to ``Concept`` /
    ``ConceptEdge``. Chunk-level provenance is preserved via ``chunk_id``
    fields the agent threads through to the output.
    """

    model_config = ConfigDict(extra="forbid")

    course_id: str
    tenant_id: str
    user_id: str
    max_concepts: int = Field(default=12, ge=3, le=40)


class SemanticAnalyzerOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    document_id: str
    tree: ConceptTree


class ConceptChunkRef(BaseModel):
    """Phase-2 helper: pairs a concept with the chunk(s) that support it.

    Kept separate from ``Concept`` (which uses ``block_refs`` indices) so
    the persistence layer can attach chunk_ids directly without forcing the
    legacy Phase-0 contract to learn about chunks.
    """

    model_config = ConfigDict(extra="forbid")

    concept_id: str
    chunk_ids: list[str] = Field(default_factory=list)


class ConceptExtractionResult(BaseModel):
    """Chunk-driven analyzer output (Phase 2)."""

    model_config = ConfigDict(extra="forbid")

    course_id: str
    concepts: list[Concept]
    edges: list[ConceptEdge]
    refs: list[ConceptChunkRef]


# ─────────────────────────────────────────────────────────────────────────────
# 4. Code Understanding
# ─────────────────────────────────────────────────────────────────────────────


class CodeNode(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    kind: Literal[
        "module", "class", "function", "method", "import", "loop", "branch", "call"
    ]
    name: str | None = None
    char_start: int
    char_end: int
    summary: str | None = None


class CodeUnderstandingInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source_path: str
    language: str
    text: str


class CodeUnderstandingOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    language: str
    frameworks: list[str] = Field(default_factory=list)
    algorithms: list[str] = Field(default_factory=list)
    nodes: list[CodeNode]


# ─────────────────────────────────────────────────────────────────────────────
# 5. Curriculum Builder
# ─────────────────────────────────────────────────────────────────────────────


class CurriculumDAG(BaseModel):
    """A directed acyclic graph over concepts. The builder MUST validate
    acyclicity before returning."""

    model_config = ConfigDict(extra="forbid")

    concepts: list[Concept]
    edges: EdgesList


class CurriculumBuilderInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    course_id: str
    tree: ConceptTree


class CurriculumBuilderOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    course_id: str
    dag: CurriculumDAG


# ─────────────────────────────────────────────────────────────────────────────
# 6. Roadmap Planner
# ─────────────────────────────────────────────────────────────────────────────


class MilestoneStatus(StrEnum):
    locked = "locked"
    pending = "pending"
    in_progress = "in_progress"
    completed = "completed"
    skipped = "skipped"


class Milestone(BaseModel):
    model_config = ConfigDict(extra="forbid")

    concept_id: str | None
    title: str
    week_index: WeekIndex
    ordinal: WeekIndex
    effort_min: PositiveInt
    status: MilestoneStatus = MilestoneStatus.pending


class StudentMastery(BaseModel):
    model_config = ConfigDict(extra="forbid")

    concept_id: str
    mastery: float = Field(ge=0.0, le=1.0)
    attempts: NonNegativeInt = 0


class StudentModelSnapshot(BaseModel):
    model_config = ConfigDict(extra="forbid")

    user_id: str
    course_id: str
    mastery: list[StudentMastery] = Field(default_factory=list)
    preferences: JsonDict = Field(default_factory=dict)


class RoadmapPlannerInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    course_id: str
    user_id: str | None = None
    weeks: WeeksHorizon
    dag: CurriculumDAG
    student_model: StudentModelSnapshot | None = None
    deadline: str | None = None  # ISO 8601


class RoadmapFromChunksInput(BaseModel):
    """Phase-2 chunk-driven entrypoint."""

    model_config = ConfigDict(extra="forbid")

    course_id: str
    tenant_id: str
    user_id: str
    query: str = ""
    weeks: int = Field(default=4, ge=1, le=16)


class RoadmapPlannerOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    course_id: str
    title: str
    weeks: WeeksHorizon
    milestones: list[Milestone]


# ─────────────────────────────────────────────────────────────────────────────
# 7. Flashcard Generator
# ─────────────────────────────────────────────────────────────────────────────


class FlashcardKind(StrEnum):
    qa = "qa"
    cloze = "cloze"
    formula = "formula"
    code = "code"


class Flashcard(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: FlashcardKind
    front: str
    back: str
    concept_id: str | None = None
    citations: CitationsList


class FlashcardGeneratorInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    course_id: str
    concepts: ConceptList


class FlashcardFromChunksInput(BaseModel):
    """Phase-2 chunk-driven entrypoint.

    Concepts come later (task P2-4). Until then the generator works from
    retrieved chunks directly — one card per high-signal chunk, with the
    chunk's own ``chunk_id`` becoming the citation anchor.
    """

    model_config = ConfigDict(extra="forbid")

    course_id: str
    tenant_id: str
    user_id: str
    query: str = ""
    """Optional topical seed; empty means "broad coverage of the corpus."""
    deck_size: int = Field(default=12, ge=1, le=50)


class FlashcardGeneratorOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    course_id: str
    deck_title: str
    flashcards: list[Flashcard]


# ─────────────────────────────────────────────────────────────────────────────
# 8. Quiz Generator
# ─────────────────────────────────────────────────────────────────────────────


class QuizItemKind(StrEnum):
    mcq = "mcq"
    true_false = "true_false"
    short_answer = "short_answer"
    coding = "coding"
    scenario = "scenario"


class QuizItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: QuizItemKind
    prompt: str
    payload: JsonDict
    """Polymorphic answer payload: MCQ options, coding test cases, etc."""
    rationale: str
    difficulty: DifficultyScore = 50
    concept_id: str | None = None
    citations: CitationsList


class QuizGeneratorInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    course_id: str
    concepts: ConceptList
    difficulty: DifficultyScore = 50
    item_count: ItemCount = 10


class QuizFromChunksInput(BaseModel):
    """Phase-2 chunk-driven entrypoint, mirroring FlashcardFromChunksInput."""

    model_config = ConfigDict(extra="forbid")

    course_id: str
    tenant_id: str
    user_id: str
    query: str = ""
    item_count: int = Field(default=6, ge=1, le=20)
    difficulty: int = Field(default=50, ge=0, le=100)


class QuizGeneratorOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    course_id: str
    title: str
    items: list[QuizItem]


# ─────────────────────────────────────────────────────────────────────────────
# 9. Diagram Agent
# ─────────────────────────────────────────────────────────────────────────────


class DiagramAgentInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    course_id: str
    concept_ids: ConceptIdList
    kind: Literal["flowchart", "mindmap", "timeline", "dependency", "algorithm"]


class DiagramFromChunksInput(BaseModel):
    """Phase-2 chunk-driven entrypoint."""

    model_config = ConfigDict(extra="forbid")

    course_id: str
    tenant_id: str
    user_id: str
    query: str = ""
    kind: Literal["flowchart", "mindmap", "sequence"] = "flowchart"


class DiagramAgentOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    course_id: str
    renderer: Literal["mermaid", "cytoscape"]
    source: str
    """Mermaid DSL string or Cytoscape JSON-as-string."""


# ─────────────────────────────────────────────────────────────────────────────
# 10. Tutor Agent
# ─────────────────────────────────────────────────────────────────────────────


class TutorInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    session_id: str
    course_id: str | None = None
    user_id: str
    tenant_id: str | None = None
    """Tenant scope for cache lookups + audit attribution. The orchestrator
    populates this from the Run; older callers without a cache wired can
    leave it ``None``."""
    query: str = Field(min_length=1, max_length=8000)
    retrieved_chunks: list[RetrievedChunk] = Field(default_factory=list)
    """Pre-retrieved chunks supplied by the RAG layer."""


class RetrievedChunk(BaseModel):
    model_config = ConfigDict(extra="forbid")

    chunk_id: str
    doc_id: str
    version_id: str
    page: int | None = None
    slide: int | None = None
    cell: int | None = None
    char_start: NonNegativeInt
    char_end: NonNegativeInt
    score: float = Field(ge=0.0, le=1.0)
    content: str


class TutorOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    session_id: str
    refusal: bool
    text: str
    citations: list[Citation]
    suggestions: list[str] = Field(default_factory=list)
    """When refusing, suggest related topics that *do* appear in the corpus."""


TutorInput.model_rebuild()


# ─────────────────────────────────────────────────────────────────────────────
# 11. Student Progress (mastery estimation)
# ─────────────────────────────────────────────────────────────────────────────


class QuizAttemptEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    attempt_id: str
    quiz_id: str
    concept_id: str | None = None
    correct: bool
    confidence: float = Field(default=0.5, ge=0.0, le=1.0)
    difficulty: DifficultyScore = 50


class StudentProgressInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    user_id: str
    course_id: str
    current_model: StudentModelSnapshot
    events: list[QuizAttemptEvent]


class StudentProgressOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    user_id: str
    course_id: str
    updated_model: StudentModelSnapshot


# ─────────────────────────────────────────────────────────────────────────────
# 12. Notification Agent
# ─────────────────────────────────────────────────────────────────────────────


class NotificationChannel(StrEnum):
    email = "email"
    push = "push"
    in_app = "in_app"


class NotificationKind(StrEnum):
    upload_ready = "upload_ready"
    milestone_due = "milestone_due"
    quiz_due = "quiz_due"
    weekly_digest = "weekly_digest"
    abuse_review = "abuse_review"
    billing_warning = "billing_warning"
    system = "system"


class ScheduledNotification(BaseModel):
    model_config = ConfigDict(extra="forbid")

    user_id: str
    kind: NotificationKind
    channel: NotificationChannel
    subject: str
    body: str
    scheduled_for: str  # ISO 8601


class NotificationAgentInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    user_id: str
    course_id: str | None = None
    progress: StudentModelSnapshot | None = None
    plan: RoadmapPlannerOutput | None = None
    horizon_hours: HorizonHours = 24


class NotificationAgentOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    user_id: str
    messages: list[ScheduledNotification]


# ─────────────────────────────────────────────────────────────────────────────
# Run / Step state machine (re-used across all agents)
# ─────────────────────────────────────────────────────────────────────────────


class RunState(StrEnum):
    queued = "queued"
    running = "running"
    succeeded = "succeeded"
    failed = "failed"
    dead_letter = "dead_letter"


class StepState(StrEnum):
    queued = "queued"
    running = "running"
    succeeded = "succeeded"
    failed = "failed"


class Step(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    agent_name: str
    agent_version: str
    state: StepState = StepState.queued
    attempts: NonNegativeInt = 0
    idempotency_key: str
    input: JsonDict
    output: JsonDict | None = None
    error: str | None = None
    started_at: str | None = None
    completed_at: str | None = None


class Run(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    tenant_id: str | None = None
    user_id: str | None = None
    kind: str
    state: RunState = RunState.queued
    attempts: NonNegativeInt = 0
    max_attempts: MaxAttempts = 5
    idempotency_key: str
    payload: JsonDict
    result: JsonDict | None = None
    error: str | None = None
    steps: list[Step] = Field(default_factory=list)
    created_at: str
    updated_at: str


__all__ = [
    "Block",
    "ChunkModality",
    "Citation",
    "CodeNode",
    "CodeUnderstandingInput",
    "CodeUnderstandingOutput",
    "Concept",
    "ConceptChunkRef",
    "ConceptEdge",
    "ConceptEdgeKind",
    "ConceptExtractionResult",
    "ConceptTree",
    "ContentChannel",
    "CurriculumBuilderInput",
    "CurriculumBuilderOutput",
    "CurriculumDAG",
    "DiagramAgentInput",
    "DiagramAgentOutput",
    "DiagramFromChunksInput",
    "DocumentParserInput",
    "DocumentParserOutput",
    "Flashcard",
    "FlashcardFromChunksInput",
    "FlashcardGeneratorInput",
    "FlashcardGeneratorOutput",
    "FlashcardKind",
    "IngestProcessInput",
    "IngestProcessOutput",
    "Milestone",
    "MilestoneStatus",
    "NotificationAgentInput",
    "NotificationAgentOutput",
    "NotificationChannel",
    "NotificationKind",
    "QuizAttemptEvent",
    "QuizFromChunksInput",
    "QuizGeneratorInput",
    "QuizGeneratorOutput",
    "QuizItem",
    "QuizItemKind",
    "RetrievedChunk",
    "RoadmapFromChunksInput",
    "RoadmapPlannerInput",
    "RoadmapPlannerOutput",
    "Run",
    "RunState",
    "SafetyFlag",
    "SafetyInput",
    "SafetyOutput",
    "SanitizedBlock",
    "ScheduledNotification",
    "SemanticAnalyzerFromChunksInput",
    "SemanticAnalyzerInput",
    "SemanticAnalyzerOutput",
    "Step",
    "StepState",
    "StudentMastery",
    "StudentModelSnapshot",
    "StudentProgressInput",
    "StudentProgressOutput",
    "TutorInput",
    "TutorOutput",
]
