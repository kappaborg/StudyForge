"""Run-store interface + in-memory implementation.

Phase 0 keeps runs in memory so the orchestrator is exercisable end-to-end
without Postgres wiring. The Postgres-backed implementation in Phase 1 simply
swaps this class out — the orchestrator never imports a concrete store.
"""

from __future__ import annotations

from typing import Protocol

from ..agents.contracts import Run


class RunStore(Protocol):
    """Persistence boundary for orchestrator runs."""

    async def upsert(self, run: Run) -> Run:
        """Insert or update a run keyed by ``run.id``. ``run.updated_at`` is
        refreshed by the store."""
        ...

    async def get(self, run_id: str) -> Run | None: ...

    async def get_by_idempotency_key(self, kind: str, key: str) -> Run | None: ...

    async def list(self, limit: int = 50) -> list[Run]: ...


class InMemoryRunStore(RunStore):
    """Dict-backed store. Thread-unsafe — fine for a single-process worker.

    Phase 1 swaps in a Postgres-backed implementation reusing the ``Job``
    table from the database schema deliverable.
    """

    def __init__(self) -> None:
        self._by_id: dict[str, Run] = {}
        self._by_key: dict[tuple[str, str], str] = {}

    async def upsert(self, run: Run) -> Run:
        from datetime import datetime, timezone

        run_dict = run.model_dump(mode="json")
        run_dict["updated_at"] = datetime.now(timezone.utc).isoformat()
        updated = Run.model_validate(run_dict)
        self._by_id[updated.id] = updated
        self._by_key[(updated.kind, updated.idempotency_key)] = updated.id
        return updated

    async def get(self, run_id: str) -> Run | None:
        return self._by_id.get(run_id)

    async def get_by_idempotency_key(self, kind: str, key: str) -> Run | None:
        run_id = self._by_key.get((kind, key))
        if run_id is None:
            return None
        return self._by_id.get(run_id)

    async def list(self, limit: int = 50) -> list[Run]:
        runs = sorted(self._by_id.values(), key=lambda r: r.created_at, reverse=True)
        return runs[:limit]
