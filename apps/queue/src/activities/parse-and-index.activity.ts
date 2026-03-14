import { Context } from "@temporalio/activity";
import { indexFiles } from "../../../codebase-reader/src/lib/indexer.js";

export interface ParseAndIndexInput {
  repositoryId: string;
  repoRoot: string;
  filePaths: string[];
}

/**
 * Parse and index a list of changed files into CodeChunk rows with embeddings.
 * Heartbeats every 10 files to keep the Temporal activity alive during long runs.
 */
export async function parseAndIndexActivity(input: ParseAndIndexInput): Promise<void> {
  const { filePaths, repositoryId, repoRoot } = input;
  const batchSize = 10;

  for (let i = 0; i < filePaths.length; i += batchSize) {
    Context.current().heartbeat(`Indexing files ${i}–${Math.min(i + batchSize, filePaths.length)} of ${filePaths.length}`);

    const batch = filePaths.slice(i, i + batchSize);
    await indexFiles({
      repositoryId,
      repoRoot,
      filePaths: batch,
      embeddingModel: process.env["EMBEDDING_MODEL"] ?? "text-embedding-3-small",
      embeddingDimensions: parseInt(process.env["EMBEDDING_DIMENSIONS"] ?? "1536", 10),
      voyageApiKey: process.env["VOYAGE_API_KEY"],
      openAiApiKey: process.env["OPENAI_API_KEY"],
    });
  }
}
