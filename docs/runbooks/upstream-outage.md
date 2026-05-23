# Upstream outage

What to do when Groq / OpenAI / Anthropic / Meili / Postgres goes
sideways. Roughly 40% of our "outages" are upstream — recognising one
fast is most of the fix.

## Detection

The clearest tell is the failure mode:

| Symptom | Likely cause |
|---------|--------------|
| All agents fall back to stub responses | Groq 429 / 5xx |
| Stream endpoints disconnect mid-response | Upstream socket reset |
| Cmd+K search returns empty for everything | Meili down |
| Uploads succeed but never appear | MinIO down |
| API responds, every endpoint returns 500 with Prisma errors | Postgres OOM / disk full |

Check each provider's status page first. If they say outage, skip
straight to mitigation.

## Groq / OpenAI / Anthropic

1. Confirm via upstream status page.
2. **If we have ≥ 2 providers wired**: failover automatically (the
   cost router rotates). Verify the next provider is healthy.
3. **If Groq-only**: agents fall back to deterministic stub
   ("[stub] showing chunk excerpt"). Tutor refuses with a clear
   message. This is by design — better than hallucinated answers.
4. Post on the status page: "Cloud AI provider is down. The product
   continues with chunk excerpts."
5. Restore: when upstream recovers, agents auto-resume on the next
   call. No action needed beyond an "all clear" post.

## Meilisearch

1. Restart with `docker compose restart studyforge-meili`.
2. If the data volume is corrupted, restore the last index dump (see
   "backup" section in `infra/`).
3. Run `POST /v1/search/reindex` to rebuild from Postgres.

Search degrades gracefully — the workspace still works without it.

## MinIO

1. Restart with `docker compose restart studyforge-minio`.
2. New uploads fail with `upload.object-missing` until restored.
3. Already-ingested chunks remain in Postgres + searchable; only
   re-download of the original PDF is impacted.

## Postgres

The hard one. If Postgres is down, **everything is down**.

1. `docker compose logs studyforge-postgres | tail -100` — look for
   OOM or disk-full.
2. `docker exec studyforge-postgres df -h /var/lib/postgresql/data`
3. If disk: free space by truncating cold log tables (`UsageEvent`
   rows older than 30 days are safe to drop on a tight box).
4. If OOM: bump container memory limit in
   `docker-compose.yml`, restart.
5. Restore from the last `pg_dump` if the data file is unrecoverable
   (see `infra/backups/`).

After a Postgres restart, run `make e2e` to verify the surface; the
streaming tutor in particular is sensitive to connection-pool resets.
