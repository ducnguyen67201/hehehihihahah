/**
 * Manually trigger syncRepositoryWorkflow for a registered repo.
 * Usage: npx tsx scripts/trigger-sync.ts <owner> <name> [branch]
 *
 * Example:
 *   npx tsx scripts/trigger-sync.ts TexWard45 my-scenario-generator main
 */
import "dotenv/config";
import { Client, Connection } from "@temporalio/client";
import { Pool } from "pg";

async function main() {
  const [owner, name, branch = "main"] = process.argv.slice(2);

  if (!owner || !name) {
    console.error("Usage: npx tsx scripts/trigger-sync.ts <owner> <name> [branch]");
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env["DATABASE_URL"] });
  const res = await pool.query(
    `SELECT id, owner, name, branch, "clonePath", "lastCommitSha" FROM "TrackedRepository"
     WHERE owner=$1 AND name=$2 AND branch=$3`,
    [owner, name, branch],
  );
  await pool.end();

  const repo = res.rows[0];
  if (!repo) {
    console.error(`Repo ${owner}/${name}@${branch} not found. Run register-repo.ts first.`);
    process.exit(1);
  }

  const temporalAddress = process.env["TEMPORAL_ADDRESS"] ?? "localhost:7233";
  const taskQueue = process.env["TEMPORAL_TASK_QUEUE"] ?? "template-task-queue";

  const connection = await Connection.connect({ address: temporalAddress });
  const client = new Client({ connection });

  const workflowId = `sync-repo-${repo.id}-manual-${Date.now()}`;
  const initialClone = !repo.lastCommitSha;

  console.log(`Triggering ${initialClone ? "initial clone" : "incremental sync"} for ${owner}/${name}@${branch}`);

  const handle = await client.workflow.start("syncRepositoryWorkflow", {
    taskQueue,
    workflowId,
    args: [
      {
        repositoryId: repo.id,
        owner: repo.owner,
        name: repo.name,
        branch: repo.branch,
        clonePath: repo.clonePath,
        lastCommitSha: repo.lastCommitSha ?? null,
        initialClone,
      },
    ],
  });

  console.log(`Workflow started: ${handle.workflowId}`);
  console.log(`Monitor at: http://localhost:8233`);
  console.log(`\nWaiting for result...`);

  await handle.result();
  console.log("Workflow completed successfully.");

  await connection.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
