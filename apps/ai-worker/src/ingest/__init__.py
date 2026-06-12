"""Ingest pipeline.

Takes a file (raw bytes) and turns it into persisted, safety-scanned chunks:

    bytes → parser → Block[] → safety_pass → SanitizedBlock[]
                                              → chunker → Chunk[]
                                              → store → (Document, Version, Chunks)

Phase-1 thin slice covers PDF only (PyMuPDF). PPTX / notebook / code / archive
parsers slot in behind the same ``Parser`` Protocol in Phase 1 mid.
"""

from .pdf import parse_pdf as parse_pdf
from .pipeline import (
    IngestRequest as IngestRequest,
)
from .pipeline import (
    IngestResult as IngestResult,
)
from .pipeline import (
    ingest_document as ingest_document,
)
from .safety_pass import safety_pass as safety_pass
from .store import (
    IngestStore as IngestStore,
)
from .store import (
    InMemoryIngestStore as InMemoryIngestStore,
)
from .store import (
    PostgresIngestStore as PostgresIngestStore,
)
