import { config as dotenvConfig } from "dotenv";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
// Load .env from monorepo root (two levels up from apps/queue)
dotenvConfig({ path: resolve(process.cwd(), "../../.env") });
dotenvConfig({ path: resolve(process.cwd(), ".env") }); // fallback for CWD
import { fileURLToPath } from "node:url";
import { NativeConnection, Worker } from "@temporalio/worker";
import { Client, Connection, ScheduleOverlapPolicy } from "@temporalio/client";
import { Pool } from "pg";
import * as activities from "./activities/index.js";
import { temporalConfig } from "./config.js";
import { workflowRegistry } from "./workflows/registry.js";

function resolveWorkflowsPath(): string {
  const distPath = fileURLToPath(new URL("./workflows/index.js", import.meta.url));
  if (existsSync(distPath)) {
    return distPath;
  }

  return fileURLToPath(new URL("./workflows/index.ts", import.meta.url));
}

/**
 * Register a Temporal cron schedule for syncRepositoryWorkflow (every 15 minutes)
 * for each active TrackedRepository. Idempotent — uses upsert semantics.
 */
async function registerSyncSchedules(client: Client): Promise<void> {
  const pool = new Pool({ connectionString: process.env["DATABASE_URL"] });
  const result = await pool.query(
    `SELECT id, owner, name, branch, "clonePath", "lastCommitSha" FROM "TrackedRepository" WHERE "isActive"=true`,
  );
  await pool.end();
  const repos = result.rows as {
    id: string; owner: string; name: string; branch: string;
    clonePath: string; lastCommitSha: string | null;
  }[];

  for (const repo of repos) {
    const scheduleId = `sync-repo-${repo.id}`;
    try {
      await client.schedule.create({
        scheduleId,
        spec: { cronExpressions: ["*/15 * * * *"] },
        action: {
          type: "startWorkflow",
          workflowType: workflowRegistry.syncRepository,
          taskQueue: temporalConfig.taskQueue,
          args: [
            {
              repositoryId: repo.id,
              owner: repo.owner,
              name: repo.name,
              branch: repo.branch,
              clonePath: repo.clonePath,
              lastCommitSha: repo.lastCommitSha ?? null,
              initialClone: false,
            },
          ],
          workflowId: `sync-repo-${repo.id}-scheduled`,
        },
        policies: {
          overlap: ScheduleOverlapPolicy.SKIP,
        },
      });
      console.log(`[worker] Registered sync schedule for ${repo.owner}/${repo.name}@${repo.branch}`);
    } catch (err: unknown) {
      // Schedule already exists — this is expected on restarts.
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("already exists") && !msg.includes("AlreadyExists")) {
        console.error(`[worker] Failed to register schedule for ${repo.id}:`, err);
      }
    }
  }
}

async function runWorker(): Promise<void> {
  const connection = await NativeConnection.connect({
    address: temporalConfig.address,
  });

  const worker = await Worker.create({
    connection,
    namespace: temporalConfig.namespace,
    taskQueue: temporalConfig.taskQueue,
    workflowsPath: resolveWorkflowsPath(),
    activities,
  });

  console.log(
    `Queue worker listening on ${temporalConfig.address} (namespace=${temporalConfig.namespace}, taskQueue=${temporalConfig.taskQueue})`
  );

  // Register sync schedules for all active repos.
  const clientConnection = await Connection.connect({ address: temporalConfig.address });
  const client = new Client({ connection: clientConnection, namespace: temporalConfig.namespace });
  await registerSyncSchedules(client);

  await worker.run();
}

runWorker().catch((error: unknown) => {
  console.error("Queue worker failed:", error);
  process.exitCode = 1;
});
