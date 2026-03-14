import { pullRepo } from "../../../codebase-reader/src/lib/git.js";

export interface GitPullInput {
  clonePath: string;
}

export interface GitPullResult {
  newHeadSha: string;
}

/**
 * Run `git pull` on an already-cloned repo and return the new HEAD SHA.
 */
export async function gitPullActivity(input: GitPullInput): Promise<GitPullResult> {
  const newHeadSha = await pullRepo(input.clonePath);
  return { newHeadSha };
}
