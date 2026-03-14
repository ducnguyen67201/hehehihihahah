import { cloneRepo } from "../../../codebase-reader/src/lib/git.js";

export interface GitCloneInput {
  owner: string;
  name: string;
  branch: string;
  clonePath: string;
}

/**
 * Clone a GitHub repository to local disk.
 * Uses GITHUB_TOKEN for private repo access.
 */
export async function gitCloneActivity(input: GitCloneInput): Promise<void> {
  const githubToken = process.env["GITHUB_TOKEN"] ?? "";
  await cloneRepo({
    owner: input.owner,
    name: input.name,
    branch: input.branch,
    clonePath: input.clonePath,
    githubToken,
  });
}
