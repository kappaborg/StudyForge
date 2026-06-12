"""In-memory ArtifactCache — for tests and dev-without-Postgres runs."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .artifact_contracts import ArtifactCache, ArtifactCacheHit


@dataclass
class _Row:
    output: dict[str, Any]
    donor_tenant_id: str
    donor_course_id: str | None
    quality_validated: bool
    hits: int = 0


class InMemoryArtifactCache(ArtifactCache):
    def __init__(self) -> None:
        self._rows: dict[tuple[str, str, str], _Row] = {}

    async def lookup(
        self,
        *,
        content_hash: str,
        agent_name: str,
        agent_version: str,
        require_validated: bool = False,
    ) -> ArtifactCacheHit | None:
        row = self._rows.get((content_hash, agent_name, agent_version))
        if row is None:
            return None
        if require_validated and not row.quality_validated:
            return None
        row.hits += 1
        return ArtifactCacheHit(
            output=row.output,
            hits=row.hits,
            donor_tenant_id=row.donor_tenant_id,
            donor_course_id=row.donor_course_id,
            quality_validated=row.quality_validated,
        )

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
        key = (content_hash, agent_name, agent_version)
        # First writer keeps donor; second writer only refreshes output if
        # row exists (callers may regenerate after a schema bump). The
        # quality flag is monotonic — once True, never reverts.
        existing = self._rows.get(key)
        if existing is None:
            self._rows[key] = _Row(
                output=output,
                donor_tenant_id=donor_tenant_id,
                donor_course_id=donor_course_id,
                quality_validated=quality_validated,
            )
            return
        existing.output = output
        if quality_validated:
            existing.quality_validated = True

    async def mark_validated(
        self,
        *,
        content_hash: str,
        agent_name: str,
        agent_version: str,
    ) -> None:
        row = self._rows.get((content_hash, agent_name, agent_version))
        if row is None:
            return
        row.quality_validated = True
