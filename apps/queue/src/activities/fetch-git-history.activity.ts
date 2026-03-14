import { updateFileHistory } from "../../../codebase-reader/src/lib/indexer.js";

export interface FetchGitHistoryInput {
  repositoryId: string;
  repoRoot: string;
  filePaths: string[];
  limit?: number;
}

/**
 * Fetch and upsert git commit history for the given files into FileCommit rows.
 */
export async function fetchGitHistoryActivity(
  input: FetchGitHistoryInput,
): Promise<void> {
  await updateFileHistory({
    repositoryId: input.repositoryId,
    repoRoot: input.repoRoot,
    filePaths: input.filePaths,
    limit: input.limit ?? 20,
  });
}
