import { simpleGit, type SimpleGit } from "simple-git";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface FileHistoryEntry {
  sha: string;
  message: string;
  author: string;
  authorEmail: string;
  committedAt: Date;
}

/**
 * Clone a GitHub repository to the specified local path.
 * Uses GITHUB_TOKEN for private repo access if provided.
 */
export async function cloneRepo(params: {
  owner: string;
  name: string;
  branch: string;
  clonePath: string;
  githubToken: string;
}): Promise<void> {
  const { owner, name, branch, clonePath, githubToken } = params;
  const remoteUrl = `https://x-access-token:${githubToken}@github.com/${owner}/${name}.git`;

  mkdirSync(dirname(clonePath), { recursive: true });

  const git = simpleGit();
  await git.clone(remoteUrl, clonePath, ["--branch", branch, "--single-branch"]);
}

/**
 * Run `git pull` on an already-cloned repo. Returns the new HEAD SHA.
 */
export async function pullRepo(clonePath: string): Promise<string> {
  const git = simpleGit(clonePath);
  await git.pull();
  const log = await git.log({ maxCount: 1 });
  return log.latest?.hash ?? "";
}

/**
 * Get the current HEAD SHA of a cloned repo.
 */
export async function getHeadSha(clonePath: string): Promise<string> {
  const git = simpleGit(clonePath);
  const log = await git.log({ maxCount: 1 });
  return log.latest?.hash ?? "";
}

/**
 * Return the list of files changed between two commits (by relative path).
 */
export async function getDiff(params: {
  clonePath: string;
  oldSha: string;
  newSha: string;
}): Promise<string[]> {
  const { clonePath, oldSha, newSha } = params;
  const git = simpleGit(clonePath);
  const result = await git.diff([`${oldSha}..${newSha}`, "--name-only"]);
  return result
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Fetch the last N commits for a given file path and return structured history.
 */
export async function getFileHistory(params: {
  clonePath: string;
  filePath: string;
  limit?: number;
}): Promise<FileHistoryEntry[]> {
  const { clonePath, filePath, limit = 20 } = params;
  const git: SimpleGit = simpleGit(clonePath);

  const log = await git.log({
    file: filePath,
    maxCount: limit,
    format: {
      hash: "%H",
      message: "%s",
      author_name: "%an",
      author_email: "%ae",
      date: "%aI",
    },
  });

  return log.all.map((entry) => ({
    sha: entry.hash,
    message: entry.message,
    author: entry.author_name,
    authorEmail: entry.author_email,
    committedAt: new Date(entry.date),
  }));
}

/**
 * List all files in the working tree of a cloned repo (respects .gitignore).
 */
export async function listTrackedFiles(clonePath: string): Promise<string[]> {
  const git = simpleGit(clonePath);
  const result = await git.raw(["ls-files"]);
  return result
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}
