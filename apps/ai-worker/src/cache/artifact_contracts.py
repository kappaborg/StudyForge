"""Course-shared artifact cache contracts.

Phase 2 §13's "course-shared artifacts" deliverable. Generators produce
deterministic output for a given chunk set + agent version pair; when a
second course uploads byte-equal materials, the second generation is a
pure cache hit. The cache is intentionally NOT tenant-scoped — the
agent layer chooses whether to surface a foreign donor's row.

Two implementations:
  * ``InMemoryArtifactCache`` — used by tests and dev runs without
    Postgres
  * ``PostgresArtifactCache`` — backs the ``ArtifactCacheEntry`` table
    from the Prisma schema
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol


@dataclass(frozen=True)
class ArtifactCacheHit:
    """Result of a successful cache lookup.

    ``output`` is the raw JSON-safe dict the donor's generator emitted —
    callers re-validate it via the agent's Pydantic output model so a
    stale schema doesn't silently produce wrong-shape responses.
    """

    output: dict[str, Any]
    hits: int
    """Post-increment hit count. The implementation bumps this atomically."""
    donor_tenant_id: str
    donor_course_id: str | None
    quality_validated: bool


class ArtifactCache(Protocol):
    """Lookup-then-store contract for the artifact cache."""

    async def lookup(
        self,
        *,
        content_hash: str,
        agent_name: str,
        agent_version: str,
        require_validated: bool = False,
    ) -> ArtifactCacheHit | None:
        """Return a cached output or None.

        ``require_validated=True`` filters out rows whose donor eval has
        not yet passed — Phase 2 exit criterion says high-stakes
        artifacts (quizzes, roadmaps) only share validated rows. The
        flashcard path can tolerate unvalidated sharing because the FE
        marks shared decks distinctly.
        """
        ...

    async def store(
        self,
        *,
        content_hash: str,
        agent_name: str,
        agent_version: str,
        output: dict[str, Any],
        donor_tenant_id: str,
        donor_course_id: str | None,
        quality_validated: bool = False,
    ) -> None:
        """Insert a new row OR upsert if (content_hash, agent_name,
        agent_version) already exists (idempotent under concurrent
        regeneration). The donor on a re-store is the FIRST writer; we
        do not overwrite ``donorTenantId`` on conflict."""
        ...

    async def mark_validated(
        self,
        *,
        content_hash: str,
        agent_name: str,
        agent_version: str,
    ) -> None:
        """Flip ``qualityValidated`` to true after the donor's eval has
        passed. No-op when no matching row exists."""
        ...
