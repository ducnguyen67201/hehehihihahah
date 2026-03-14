import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { parseFile, detectLanguage } from "./parser.js";
import { embedBatch } from "./embedder.js";
import { getFileHistory } from "./git.js";

function getPool(): Pool {
  return new Pool({ connectionString: process.env["DATABASE_URL"] });
}

function cuid(): string {
  return "c" + randomBytes(11).toString("base64url").slice(0, 24);
}

export interface IndexFilesParams {
  repositoryId: string;
  repoRoot: string;
  filePaths: string[];
  embeddingModel: string;
  embeddingDimensions: number;
  voyageApiKey?: string;
  openAiApiKey?: string;
}

/**
 * Parse, embed, and upsert CodeFile + CodeChunk records for the given file paths.
 * Deletes stale chunks before inserting new ones (full re-index per file).
 */
export async function indexFiles(params: IndexFilesParams): Promise<void> {
  const {
    repositoryId,
    repoRoot,
    filePaths,
    embeddingModel,
    embeddingDimensions,
    voyageApiKey,
    openAiApiKey,
  } = params;

  const pool = getPool();

  try {
    for (const filePath of filePaths) {
      const language = detectLanguage(filePath);
      if (!language) continue;

      const absolutePath = join(repoRoot, filePath);
      let source: string;
      try {
        source = readFileSync(absolutePath, "utf-8");
      } catch {
        continue;
      }

      const contentHash = sha256(source);

      // Check if file content has changed.
      const existing = await pool.query(
        `SELECT id, "contentHash" FROM "CodeFile" WHERE "repositoryId"=$1 AND path=$2`,
        [repositoryId, filePath],
      );

      if (existing.rows[0]?.contentHash === contentHash) continue;

      // Parse into chunks.
      const chunks = parseFile({ filePath, repoRoot });
      if (!chunks || chunks.length === 0) continue;

      // Batch embed all chunk contents.
      const contents = chunks.map((c) => c.content);
      const embeddings = await embedBatch(contents, {
        model: embeddingModel,
        dimensions: embeddingDimensions,
        voyageApiKey,
        openAiApiKey,
      });

      // Upsert CodeFile record.
      const now = new Date().toISOString();
      let fileId: string;
      if (existing.rows[0]) {
        fileId = existing.rows[0].id as string;
        await pool.query(
          `UPDATE "CodeFile" SET language=$1, "contentHash"=$2, "indexedAt"=$3 WHERE id=$4`,
          [language, contentHash, now, fileId],
        );
      } else {
        fileId = cuid();
        await pool.query(
          `INSERT INTO "CodeFile" (id, path, language, "contentHash", "indexedAt", "repositoryId")
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [fileId, filePath, language, contentHash, now, repositoryId],
        );
      }

      // Delete old chunks.
      await pool.query(`DELETE FROM "CodeChunk" WHERE "fileId"=$1`, [fileId]);

      // Insert new chunks with embeddings.
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const embedding = embeddings[i];
        if (!chunk) continue;

        const embeddingParam = embedding ? `'[${embedding.join(",")}]'::vector` : "NULL";
        await pool.query(
          `INSERT INTO "CodeChunk" (id, "chunkType", "symbolName", "startLine", "endLine", content, embedding, "createdAt", "fileId")
           VALUES ($1, $2::\"ChunkType\", $3, $4, $5, $6, ${embeddingParam}, NOW(), $7)`,
          [cuid(), chunk.chunkType, chunk.symbolName ?? null, chunk.startLine, chunk.endLine, chunk.content, fileId],
        );
      }

      console.log(`[indexer] Indexed ${chunks.length} chunks for ${filePath}`);
    }
  } finally {
    await pool.end();
  }
}

/**
 * Upsert FileCommit records for the given file paths.
 */
export async function updateFileHistory(params: {
  repositoryId: string;
  repoRoot: string;
  filePaths: string[];
  limit?: number;
}): Promise<void> {
  const { repositoryId, repoRoot, filePaths, limit = 20 } = params;
  const pool = getPool();

  try {
    for (const filePath of filePaths) {
      const fileRes = await pool.query(
        `SELECT id FROM "CodeFile" WHERE "repositoryId"=$1 AND path=$2`,
        [repositoryId, filePath],
      );
      if (!fileRes.rows[0]) continue;
      const fileId = fileRes.rows[0].id as string;

      const history = await getFileHistory({ clonePath: repoRoot, filePath, limit });

      for (const entry of history) {
        await pool.query(
          `INSERT INTO "FileCommit" (id, sha, message, author, "authorEmail", "committedAt", "fileId")
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT ("fileId", sha) DO UPDATE
             SET message=EXCLUDED.message, author=EXCLUDED.author,
                 "authorEmail"=EXCLUDED."authorEmail", "committedAt"=EXCLUDED."committedAt"`,
          [cuid(), entry.sha, entry.message, entry.author, entry.authorEmail, entry.committedAt.toISOString(), fileId],
        );
      }

      const latest = history[0];
      if (latest) {
        await pool.query(
          `UPDATE "CodeFile" SET "lastCommitSha"=$1, "lastCommitMessage"=$2, "lastCommitAuthor"=$3, "lastCommitAt"=$4 WHERE id=$5`,
          [latest.sha, latest.message, latest.author, latest.committedAt.toISOString(), fileId],
        );
      }
    }
  } finally {
    await pool.end();
  }
}

/**
 * Remove CodeFile records for files no longer in the repo.
 */
export async function removeDeletedFiles(params: {
  repositoryId: string;
  currentFilePaths: string[];
}): Promise<void> {
  const { repositoryId, currentFilePaths } = params;
  const pool = getPool();
  const placeholders = currentFilePaths.map((_, i) => `$${i + 2}`).join(",");
  const query = currentFilePaths.length > 0
    ? `DELETE FROM "CodeFile" WHERE "repositoryId"=$1 AND path NOT IN (${placeholders})`
    : `DELETE FROM "CodeFile" WHERE "repositoryId"=$1`;
  await pool.query(query, [repositoryId, ...currentFilePaths]);
  await pool.end();
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
