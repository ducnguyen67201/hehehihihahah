/**
 * Show index stats after syncing.
 * Usage: npx tsx scripts/query-codebase.ts
 */
import "dotenv/config";
import { Pool } from "pg";

async function main() {
  const pool = new Pool({ connectionString: process.env["DATABASE_URL"] });

  // Repos
  const repos = await pool.query(`SELECT owner, name, branch, "lastSyncedAt" FROM "TrackedRepository"`);
  console.log("=== Tracked Repositories ===");
  for (const r of repos.rows) {
    console.log(`  ${r.owner}/${r.name}@${r.branch} — lastSync: ${r.lastSyncedAt ?? "never"}`);
  }

  // Stats
  const files = await pool.query(`SELECT COUNT(*) FROM "CodeFile"`);
  const chunks = await pool.query(`SELECT COUNT(*) FROM "CodeChunk"`);
  console.log(`\n=== Index Stats ===`);
  console.log(`  Files:  ${files.rows[0].count}`);
  console.log(`  Chunks: ${chunks.rows[0].count}`);

  if (parseInt(chunks.rows[0].count) === 0) {
    console.log("\nNo chunks indexed yet. Run the sync workflow first.");
    await pool.end();
    return;
  }

  // First 5 functions
  const symbols = await pool.query(
    `SELECT c."symbolName", f.path, c."startLine", c."endLine"
     FROM "CodeChunk" c JOIN "CodeFile" f ON f.id = c."fileId"
     WHERE c."chunkType"='FUNCTION'
     LIMIT 5`,
  );
  console.log(`\n=== Indexed Functions (first 5) ===`);
  for (const s of symbols.rows) {
    console.log(`  ${s.symbolName ?? "(anonymous)"} @ ${s.path}:${s.startLine}-${s.endLine}`);
  }

  // Embedding coverage
  const embedded = await pool.query(
    `SELECT COUNT(*) FROM "CodeChunk" WHERE embedding IS NOT NULL`,
  );
  console.log(`\n=== Embedding Coverage ===`);
  console.log(`  ${embedded.rows[0].count} / ${chunks.rows[0].count} chunks have embeddings`);

  // Recent commits
  const commits = await pool.query(
    `SELECT fc.sha, fc.author, fc.message, fc."committedAt", f.path
     FROM "FileCommit" fc JOIN "CodeFile" f ON f.id = fc."fileId"
     ORDER BY fc."committedAt" DESC LIMIT 5`,
  );
  console.log(`\n=== Recent Commits ===`);
  for (const c of commits.rows) {
    const date = new Date(c.committedAt).toISOString().slice(0, 10);
    console.log(`  [${date}] ${c.author}: ${c.message} — ${c.path}`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
