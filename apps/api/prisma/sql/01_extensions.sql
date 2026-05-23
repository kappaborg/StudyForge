-- Required Postgres extensions. Idempotent — safe to re-run.
-- pgvector: dense embeddings + HNSW indexes for Chunk / Concept / CachedResponse.
-- pgcrypto: gen_random_uuid + digest() for the audit hash chain.
-- pg_trgm:  trigram search over Chunk.content for fuzzy lookups when BM25 fails.
-- citext:   case-insensitive content hashes.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS citext;
