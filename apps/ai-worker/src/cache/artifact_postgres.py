"""Postgres ArtifactCache backed by the ``ArtifactCacheEntry`` table.

Lookup increments ``hits`` and stamps ``lastHitAt`` atomically so
dashboards can show real cache effectiveness. Insert is an upsert on the
``(contentHash, agentName, agentVersion)`` unique key so concurrent
regenerations don't collide.

Tenant isolation lives in the agent layer — the cache is cross-tenant
by design.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any

from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import AsyncConnectionPool

from .artifact_contracts import ArtifactCache, ArtifactCacheHit

log = logging.getLogger(__name__)


@dataclass
class PostgresArtifactCache(ArtifactCache):
    pool: AsyncConnectionPool

    async def lookup(
        self,
        *,
        content_hash: str,
        agent_name: str,
        agent_version: str,
        require_validated: bool = False,
    ) -> ArtifactCacheHit | None:
        # Single round-trip: bump hits + read the row in one
        # ``UPDATE ... RETURNING``. Wrapping in a CTE keeps the increment
        # tied to the SELECT predicate so a row that gets validated
        # between our SELECT and UPDATE doesn't slip through.
        validated_filter = 'AND "qualityValidated" = true' if require_validated else ""
        sql = f"""
            UPDATE "ArtifactCacheEntry"
               SET hits = hits + 1,
                   "lastHitAt" = now()
             WHERE "contentHash" = %(content_hash)s
               AND "agentName" = %(agent_name)s
               AND "agentVersion" = %(agent_version)s
               {validated_filter}
         RETURNING "outputJson", hits,
                   "donorTenantId"::text AS donor_tenant_id,
                   "donorCourseId"::text AS donor_course_id,
                   "qualityValidated" AS quality_validated
        """
        async with self.pool.connection() as conn:
            async with conn.cursor(row_factory=dict_row) as cur:
                await cur.execute(
                    sql,
                    {
                        "content_hash": content_hash,
                        "agent_name": agent_name,
                        "agent_version": agent_version,
                    },
                )
                row = await cur.fetchone()
                await conn.commit()
                if row is None:
                    return None

        output = row["outputJson"]
        if isinstance(output, str):
            output = json.loads(output)
        return ArtifactCacheHit(
            output=output,
            hits=int(row["hits"]),
            donor_tenant_id=row["donor_tenant_id"],
            donor_course_id=row["donor_course_id"],
            quality_validated=bool(row["quality_validated"]),
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
        # On conflict, refresh the JSON body (schema bumps) but preserve
        # ``donorTenantId`` and ``createdAt`` (audit trail). The validated
        # flag is monotonic: once True it never reverts even if a later
        # writer passes False.
        sql = """
            INSERT INTO "ArtifactCacheEntry" (
                id, "contentHash", "agentName", "agentVersion", "outputJson",
                "donorTenantId", "donorCourseId", "qualityValidated"
            )
            VALUES (
                gen_random_uuid(), %(content_hash)s, %(agent_name)s,
                %(agent_version)s, %(output_json)s,
                %(donor_tenant_id)s::uuid, %(donor_course_id)s::uuid,
                %(quality_validated)s
            )
            ON CONFLICT ("contentHash", "agentName", "agentVersion") DO UPDATE
                SET "outputJson" = EXCLUDED."outputJson",
                    "qualityValidated" = "ArtifactCacheEntry"."qualityValidated"
                                       OR EXCLUDED."qualityValidated"
        """
        async with self.pool.connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    sql,
                    {
                        "content_hash": content_hash,
                        "agent_name": agent_name,
                        "agent_version": agent_version,
                        "output_json": Jsonb(output),
                        "donor_tenant_id": donor_tenant_id,
                        "donor_course_id": donor_course_id,
                        "quality_validated": quality_validated,
                    },
                )
                await conn.commit()

    async def mark_validated(
        self,
        *,
        content_hash: str,
        agent_name: str,
        agent_version: str,
    ) -> None:
        sql = """
            UPDATE "ArtifactCacheEntry"
               SET "qualityValidated" = true
             WHERE "contentHash" = %(content_hash)s
               AND "agentName" = %(agent_name)s
               AND "agentVersion" = %(agent_version)s
        """
        async with self.pool.connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    sql,
                    {
                        "content_hash": content_hash,
                        "agent_name": agent_name,
                        "agent_version": agent_version,
                    },
                )
                await conn.commit()
