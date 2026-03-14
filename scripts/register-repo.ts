/**
 * Register a GitHub repo for indexing.
 * Usage: npx tsx scripts/register-repo.ts <owner> <name> [branch]
 *
 * Example:
 *   npx tsx scripts/register-repo.ts TexWard45 my-scenario-generator main
 */
import "dotenv/config";
import { Pool } from "pg";

async function main() {
  const [owner, name, branch = "main"] = process.argv.slice(2);

  if (!owner || !name) {
    console.error("Usage: npx tsx scripts/register-repo.ts <owner> <name> [branch]");
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env["DATABASE_URL"] });
  const codeReposDir = process.env["CODE_REPOS_DIR"] ?? "D:/repos";
  const clonePath = `${codeReposDir}/${owner}/${name}/${branch}`;

  // Check if already registered
  const check = await pool.query(
    `SELECT id, "isActive" FROM "TrackedRepository" WHERE owner=$1 AND name=$2 AND branch=$3`,
    [owner, name, branch],
  );

  if (check.rows.length > 0) {
    const row = check.rows[0];
    console.log(`Already registered (id=${row.id}). Updating isActive=true.`);
    await pool.query(`UPDATE "TrackedRepository" SET "isActive"=true WHERE id=$1`, [row.id]);
    console.log("Done.");
    await pool.end();
    return;
  }

  // Generate a cuid-like id using crypto
  const { randomBytes } = await import("node:crypto");
  const id = "c" + randomBytes(11).toString("base64url").slice(0, 24);

  const now = new Date().toISOString();
  await pool.query(
    `INSERT INTO "TrackedRepository" (id, owner, name, branch, "clonePath", "isActive", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, true, $6, $7)`,
    [id, owner, name, branch, clonePath, now, now],
  );

  console.log(`Registered ${owner}/${name}@${branch}`);
  console.log(`  id:        ${id}`);
  console.log(`  clonePath: ${clonePath}`);

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
