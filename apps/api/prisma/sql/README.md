# Supplemental SQL

Things Prisma's migration generator cannot express on its own. Applied **after**
`prisma migrate deploy` finishes the auto-generated migration, in numeric order.

| File | What it does |
| --- | --- |
| `01_extensions.sql`         | `vector`, `pgcrypto`, `pg_trgm`, `citext` |
| `02_vector_indexes.sql`     | HNSW indexes on `Chunk.embedding`, `Concept.embedding`, `CachedResponse.queryEmbedding` |
| `03_search_indexes.sql`     | `Chunk.tsv` trigger + GIN; trigram fallback; partial indexes over soft-deleted rows |
| `04_rls.sql`                | `studyforge_app` role + `tenant_isolation` policies on every tenant-scoped table |
| `05_audit_hash_chain.sql`   | `audit_log_seal` trigger (compute & block UPDATE/DELETE) and `audit_log_verify()` walker |

Run all of them after migrations:

```bash
pnpm --filter api exec prisma migrate deploy
for f in apps/api/prisma/sql/[0-9]*.sql; do
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"
done
```

The Makefile target `make db-setup` does both steps.
