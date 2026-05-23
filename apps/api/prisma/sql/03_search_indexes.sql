-- BM25-flavoured sparse retrieval over Chunk.tsv. The trigger keeps tsv in sync
-- with content + modality so application code can ignore the projection.

CREATE OR REPLACE FUNCTION chunk_tsv_refresh() RETURNS trigger AS $$
BEGIN
  NEW."tsv" :=
    setweight(to_tsvector('english', coalesce(NEW."content", '')), 'A') ||
    setweight(to_tsvector('simple',  coalesce(NEW."modality"::text, '')), 'B');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS chunk_tsv_refresh_trg ON "Chunk";
CREATE TRIGGER chunk_tsv_refresh_trg
  BEFORE INSERT OR UPDATE OF "content", "modality"
  ON "Chunk"
  FOR EACH ROW EXECUTE FUNCTION chunk_tsv_refresh();

CREATE INDEX IF NOT EXISTS "Chunk_tsv_gin_idx"
  ON "Chunk" USING gin ("tsv");

-- Trigram fallback for partial-word lookups (course-workspace global search).
CREATE INDEX IF NOT EXISTS "Chunk_content_trgm_idx"
  ON "Chunk" USING gin ("content" gin_trgm_ops);

-- Concept label autocomplete.
CREATE INDEX IF NOT EXISTS "Concept_label_trgm_idx"
  ON "Concept" USING gin ("label" gin_trgm_ops);

-- Partial index over not-yet-soft-deleted rows used by the hot read paths.
CREATE INDEX IF NOT EXISTS "Course_tenant_alive_idx"
  ON "Course" ("tenantId") WHERE "deletedAt" IS NULL;

CREATE INDEX IF NOT EXISTS "Document_tenant_alive_idx"
  ON "Document" ("tenantId") WHERE "deletedAt" IS NULL;

CREATE INDEX IF NOT EXISTS "User_tenant_alive_idx"
  ON "User" ("tenantId") WHERE "deletedAt" IS NULL;
