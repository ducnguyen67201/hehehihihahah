import { Pool } from "pg";

export interface UpdateRepoSyncStateInput {
  repositoryId: string;
  lastCommitSha: string;
}

/**
 * Persist the post-sync state on a TrackedRepository record.
 * Called at the end of syncRepositoryWorkflow to mark sync completion.
 */
export async function updateRepoSyncState(
  input: UpdateRepoSyncStateInput,
): Promise<void> {
  const pool = new Pool({ connectionString: process.env["DATABASE_URL"] });
  await pool.query(
    `UPDATE "TrackedRepository" SET "lastCommitSha"=$1, "lastSyncedAt"=$2, "updatedAt"=$2 WHERE id=$3`,
    [input.lastCommitSha, new Date().toISOString(), input.repositoryId],
  );
  await pool.end();
}
