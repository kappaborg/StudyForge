-- HNSW indexes for sub-second ANN retrieval. Build is parallel; rebuild offline
-- if the chunk corpus changes by more than ~20% (tracked by the eval harness).

-- Chunk-level embeddings power tutor RAG and quiz/flashcard generation.
CREATE INDEX IF NOT EXISTS "Chunk_embedding_hnsw_idx"
  ON "Chunk" USING hnsw ("embedding" vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Concept-level embeddings power knowledge-graph navigation and roadmap planning.
CREATE INDEX IF NOT EXISTS "Concept_embedding_hnsw_idx"
  ON "Concept" USING hnsw ("embedding" vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Semantic cache lookups: route_request → cached_response by approximate query similarity.
CREATE INDEX IF NOT EXISTS "CachedResponse_queryEmbedding_hnsw_idx"
  ON "CachedResponse" USING hnsw ("queryEmbedding" vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Default search-time ef. Application code SHOULD set per-query via SET LOCAL.
-- Apply once per database (DBA task, depends on environment name):
--   ALTER DATABASE studyforge SET hnsw.ef_search = 40;
