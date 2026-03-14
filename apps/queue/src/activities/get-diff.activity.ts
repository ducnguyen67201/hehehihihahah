import { getDiff } from "../../../codebase-reader/src/lib/git.js";

export interface GetDiffInput {
  clonePath: string;
  oldSha: string;
  newSha: string;
}

export interface GetDiffResult {
  changedFiles: string[];
}

/**
 * Compute the list of files changed between two commits.
 */
export async function getDiffActivity(input: GetDiffInput): Promise<GetDiffResult> {
  const changedFiles = await getDiff({
    clonePath: input.clonePath,
    oldSha: input.oldSha,
    newSha: input.newSha,
  });
  return { changedFiles };
}
