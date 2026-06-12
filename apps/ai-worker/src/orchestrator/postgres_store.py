"""Postgres-backed RunStore.

Persists orchestrator runs to the ``Job`` table from Deliverable 3. The store
is a drop-in for ``InMemoryRunStore`` — the orchestrator never knows which one
it has.

Persistence model:

  * One ``Job`` row per run, keyed by ``Run.id``.
  * Steps are stored as a JSONB array on ``Job.steps``. The orchestrator
    resumes from the first non-terminal step on retry; querying individual
    steps relationally is rare so denormalising is the right trade-off.
  * Idempotency: ``(kind, idempotencyKey)`` is a unique index on the Job
    table (kind narrows the namespace; the key is unique). ``upsert`` uses
    ``INSERT ... ON CONFLICT (id) DO UPDATE`` keyed on the primary id —
    callers detect duplicates via ``get_by_idempotency_key`` first.

The store handles a quirk of psycopg3: ``state`` is a Postgres enum
(``"JobState"``), so every write casts the parameter explicitly via
``%s::"JobState"``.
"""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime

from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import AsyncConnectionPool

from ..agents.contracts import Run
from .store import RunStore

log = logging.getLogger(__name__)


class PostgresRunStore(RunStore):
    """Async run store backed by the Job table."""

    def __init__(self, pool: AsyncConnectionPool) -> None:
        self._pool = pool

    # ── upsert ────────────────────────────────────────────────────────────────

    async def upsert(self, run: Run) -> Run:
        """Insert or update. Refreshes ``updated_at`` on the row."""
        now_iso = datetime.now(UTC).isoformat()
        run_dict = run.model_dump(mode="json")
        run_dict["updated_at"] = now_iso
        refreshed = Run.model_validate(run_dict)

        async with self._pool.connection() as conn, conn.cursor() as cur:
            await cur.execute(
                """
                    INSERT INTO "Job" (
                      id, "tenantId", "userId", kind, state, attempts,
                      "maxAttempts", "idempotencyKey", payload, steps,
                      result, error, "startedAt", "completedAt",
                      "createdAt", "updatedAt", "scheduledFor"
                    )
                    VALUES (
                      %s, %s, %s, %s, %s::"JobState", %s,
                      %s, %s, %s, %s,
                      %s, %s, NULL, %s,
                      %s, %s, %s
                    )
                    ON CONFLICT (id) DO UPDATE SET
                      "tenantId"   = EXCLUDED."tenantId",
                      "userId"     = EXCLUDED."userId",
                      kind         = EXCLUDED.kind,
                      state        = EXCLUDED.state,
                      attempts     = EXCLUDED.attempts,
                      "maxAttempts"= EXCLUDED."maxAttempts",
                      payload      = EXCLUDED.payload,
                      steps        = EXCLUDED.steps,
                      result       = EXCLUDED.result,
                      error        = EXCLUDED.error,
                      "completedAt"= EXCLUDED."completedAt",
                      "updatedAt"  = EXCLUDED."updatedAt"
                    """,
                (
                    refreshed.id,
                    refreshed.tenant_id,
                    refreshed.user_id,
                    refreshed.kind,
                    refreshed.state.value,
                    refreshed.attempts,
                    refreshed.max_attempts,
                    refreshed.idempotency_key,
                    Jsonb(refreshed.payload),
                    Jsonb([s.model_dump(mode="json") for s in refreshed.steps]),
                    Jsonb(refreshed.result) if refreshed.result is not None else None,
                    refreshed.error,
                    _completed_at_iso(refreshed),
                    refreshed.created_at,
                    refreshed.updated_at,
                    refreshed.created_at,  # scheduledFor: align with created_at by default
                ),
            )
        return refreshed

    # ── get ───────────────────────────────────────────────────────────────────

    async def get(self, run_id: str) -> Run | None:
        async with self._pool.connection() as conn:
            async with conn.cursor(row_factory=dict_row) as cur:
                await cur.execute(
                    'SELECT * FROM "Job" WHERE id = %s::uuid LIMIT 1', (run_id,)
                )
                row = await cur.fetchone()
        return _row_to_run(row) if row else None

    async def get_by_idempotency_key(self, kind: str, key: str) -> Run | None:
        async with self._pool.connection() as conn:
            async with conn.cursor(row_factory=dict_row) as cur:
                await cur.execute(
                    'SELECT * FROM "Job" WHERE kind = %s AND "idempotencyKey" = %s LIMIT 1',
                    (kind, key),
                )
                row = await cur.fetchone()
        return _row_to_run(row) if row else None

    async def list(self, limit: int = 50) -> list[Run]:
        async with self._pool.connection() as conn:
            async with conn.cursor(row_factory=dict_row) as cur:
                await cur.execute(
                    'SELECT * FROM "Job" ORDER BY "createdAt" DESC LIMIT %s', (limit,)
                )
                rows = await cur.fetchall()
        return [_row_to_run(r) for r in rows]


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────


def _completed_at_iso(run: Run) -> str | None:
    if run.state.value in {"succeeded", "failed", "dead_letter"}:
        try:
            return datetime.fromisoformat(run.updated_at).isoformat()
        except ValueError:
            return None
    return None


def _row_to_run(row: dict[str, object]) -> Run:
    # `payload`, `steps`, `result` come back as already-parsed JSON values
    # because the column types are JSONB.
    payload = row.get("payload") or {}
    steps = row.get("steps") or []
    result = row.get("result")

    if isinstance(payload, str):
        payload = json.loads(payload)
    if isinstance(steps, str):
        steps = json.loads(steps)
    if isinstance(result, str):
        result = json.loads(result)

    state_value = row["state"]
    if hasattr(state_value, "value"):
        state_value = state_value.value

    return Run.model_validate(
        {
            "id": str(row["id"]),
            "tenant_id": str(row["tenantId"]) if row.get("tenantId") else None,
            "user_id": str(row["userId"]) if row.get("userId") else None,
            "kind": row["kind"],
            "state": state_value,
            "attempts": row["attempts"],
            "max_attempts": row["maxAttempts"],
            "idempotency_key": row["idempotencyKey"],
            "payload": payload,
            "result": result,
            "error": row.get("error"),
            "steps": steps,
            "created_at": row["createdAt"].isoformat()
            if isinstance(row["createdAt"], datetime)
            else row["createdAt"],
            "updated_at": row["updatedAt"].isoformat()
            if isinstance(row["updatedAt"], datetime)
            else row["updatedAt"],
        }
    )


__all__ = ["PostgresRunStore"]
