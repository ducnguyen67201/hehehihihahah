-- Add pgvector embedding column to CodeChunk
-- Dimensions depend on the embedding model:
--   voyage-code-3 → 1024 dimensions
--   text-embedding-3-small → 1536 dimensions
-- Default to 1536 (text-embedding-3-small); change to 1024 if using voyage-code-3.
ALTER TABLE "CodeChunk" ADD COLUMN "embedding" vector(1536);

-- Create an ivfflat index for approximate nearest-neighbor search
-- Tune lists based on row count: sqrt(n_rows) is a good starting point.
CREATE INDEX IF NOT EXISTS "CodeChunk_embedding_idx"
    ON "CodeChunk" USING ivfflat ("embedding" vector_cosine_ops) WITH (lists = 100);
