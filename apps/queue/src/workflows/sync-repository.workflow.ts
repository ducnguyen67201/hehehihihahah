import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities/index.js";

export interface SyncRepositoryInput {
  repositoryId: string;
  owner: string;
  name: string;
  branch: string;
  clonePath: string;
  lastCommitSha: string | null;
  /** When true, clone from scratch instead of pulling. */
  initialClone?: boolean;
}

const {
  gitCloneActivity,
  gitPullActivity,
  getDiffActivity,
  parseAndIndexActivity,
  fetchGitHistoryActivity,
} = proxyActivities<typeof activities>({
  startToCloseTimeout: "30 minutes",
  heartbeatTimeout: "2 minutes",
  retry: {
    maximumAttempts: 5,
    initialInterval: "10 seconds",
    backoffCoefficient: 2,
  },
});

// Import prisma via a side-channel activity so the workflow bundle stays pure.
// Direct DB access in workflow code is prohibited by Temporal's determinism rules.
// We use a dedicated activity for the DB update at the end.
const { updateRepoSyncState } = proxyActivities<{
  updateRepoSyncState: (input: {
    repositoryId: string;
    lastCommitSha: string;
  }) => Promise<void>;
}>({
  startToCloseTimeout: "30 seconds",
});

export async function syncRepositoryWorkflow(
  input: SyncRepositoryInput,
): Promise<void> {
  const {
    repositoryId,
    owner,
    name,
    branch,
    clonePath,
    lastCommitSha,
    initialClone = false,
  } = input;

  if (initialClone) {
    // ── Initial ingestion ──────────────────────────────────────────
    await gitCloneActivity({ owner, name, branch, clonePath });

    // Pull HEAD sha after clone.
    const { newHeadSha } = await gitPullActivity({ clonePath });

    // Index all files.
    const { changedFiles } = await getDiffActivity({
      clonePath,
      // Use empty tree SHA to diff against "nothing" (all files).
      oldSha: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
      newSha: newHeadSha,
    });

    if (changedFiles.length > 0) {
      await parseAndIndexActivity({ repositoryId, repoRoot: clonePath, filePaths: changedFiles });
      await fetchGitHistoryActivity({ repositoryId, repoRoot: clonePath, filePaths: changedFiles });
    }

    await updateRepoSyncState({ repositoryId, lastCommitSha: newHeadSha });
    return;
  }

  // ── Scheduled incremental sync ─────────────────────────────────
  const { newHeadSha } = await gitPullActivity({ clonePath });

  // No changes since last sync — exit early.
  if (lastCommitSha && newHeadSha === lastCommitSha) {
    return;
  }

  const { changedFiles } = await getDiffActivity({
    clonePath,
    oldSha: lastCommitSha ?? "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
    newSha: newHeadSha,
  });

  if (changedFiles.length > 0) {
    await parseAndIndexActivity({ repositoryId, repoRoot: clonePath, filePaths: changedFiles });
    await fetchGitHistoryActivity({ repositoryId, repoRoot: clonePath, filePaths: changedFiles });
  }

  await updateRepoSyncState({ repositoryId, lastCommitSha: newHeadSha });
}
