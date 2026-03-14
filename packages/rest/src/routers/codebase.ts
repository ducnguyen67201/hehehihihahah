import { TRPCError } from "@trpc/server";
import { Client, Connection, ScheduleOverlapPolicy } from "@temporalio/client";
import { createTRPCRouter, publicProcedure } from "../init";
import {
  RegisterRepoSchema,
  SemanticSearchSchema,
  FileLookupSchema,
  RecentChangesSchema,
  SymbolLookupSchema,
  BlameOwnershipSchema,
  type CodeQueryResult,
} from "@shared/types";

export const codebaseRouter = createTRPCRouter({
  /**
   * Register a new repository for indexing.
   * Creates a TrackedRepository record and triggers the initial clone workflow.
   * Admin-only in production — callers are responsible for gating this.
   */
  registerRepo: publicProcedure
    .input(RegisterRepoSchema)
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.prisma.trackedRepository.findUnique({
        where: {
          owner_name_branch: {
            owner: input.owner,
            name: input.name,
            branch: input.branch,
          },
        },
      });

      if (existing) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `Repository ${input.owner}/${input.name}@${input.branch} is already registered`,
        });
      }

      const clonePath = [
        process.env["CODE_REPOS_DIR"] ?? "/data/repos",
        input.owner,
        input.name,
        input.branch,
      ].join("/");

      const repo = await ctx.prisma.trackedRepository.create({
        data: {
          owner: input.owner,
          name: input.name,
          branch: input.branch,
          clonePath,
        },
      });

      // Trigger initial clone workflow + register ongoing cron schedule.
      const temporalAddress = process.env["TEMPORAL_ADDRESS"] ?? "localhost:7233";
      const temporalNamespace = process.env["TEMPORAL_NAMESPACE"] ?? "default";
      const taskQueue = process.env["TEMPORAL_TASK_QUEUE"] ?? "template-task-queue";

      const connection = await Connection.connect({ address: temporalAddress });
      const client = new Client({ connection, namespace: temporalNamespace });

      // Start the one-off initial clone immediately.
      await client.workflow.start("syncRepositoryWorkflow", {
        taskQueue,
        workflowId: `sync-repo-${repo.id}-initial`,
        args: [
          {
            repositoryId: repo.id,
            owner: repo.owner,
            name: repo.name,
            branch: repo.branch,
            clonePath: repo.clonePath,
            lastCommitSha: null,
            initialClone: true,
          },
        ],
      });

      // Register the 15-min recurring cron schedule for this repo.
      try {
        await client.schedule.create({
          scheduleId: `sync-repo-${repo.id}`,
          spec: { cronExpressions: ["*/15 * * * *"] },
          action: {
            type: "startWorkflow",
            workflowType: "syncRepositoryWorkflow",
            taskQueue,
            args: [
              {
                repositoryId: repo.id,
                owner: repo.owner,
                name: repo.name,
                branch: repo.branch,
                clonePath: repo.clonePath,
                lastCommitSha: null,
                initialClone: false,
              },
            ],
            workflowId: `sync-repo-${repo.id}-scheduled`,
          },
          policies: { overlap: ScheduleOverlapPolicy.SKIP },
        });
      } catch (err: unknown) {
        // Schedule already exists — safe to ignore.
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("already exists") && !msg.includes("AlreadyExists")) {
          throw err;
        }
      }

      await connection.close();

      return {
        id: repo.id,
        owner: repo.owner,
        name: repo.name,
        branch: repo.branch,
        clonePath: repo.clonePath,
        createdAt: repo.createdAt,
      };
    }),

  /**
   * Semantic search over indexed code chunks using pgvector cosine similarity.
   * Embeds the query string then queries the vector index.
   */
  semanticSearch: publicProcedure
    .input(SemanticSearchSchema)
    .query(async ({ ctx, input }): Promise<CodeQueryResult[]> => {
      // Dynamic import to avoid bundling embedder in all consumers
      const { embedQuery } = await import("../lib/embed");
      const queryEmbedding = await embedQuery(input.query);
      const embeddingLiteral = `[${queryEmbedding.join(",")}]`;

      const repoFilter =
        input.repoIds && input.repoIds.length > 0
          ? `AND f."repositoryId" = ANY(ARRAY[${input.repoIds.map((id) => `'${id}'`).join(",")}]::text[])`
          : "";

      type RawRow = {
        id: string;
        chunkType: string;
        symbolName: string | null;
        startLine: number;
        endLine: number;
        content: string;
        filePath: string;
        language: string;
        lastCommitSha: string | null;
        lastCommitMessage: string | null;
        lastCommitAuthor: string | null;
        lastCommitAt: Date | null;
        distance: number;
      };

      const rows = await ctx.prisma.$queryRawUnsafe<RawRow[]>(
        `SELECT
          c."id",
          c."chunkType",
          c."symbolName",
          c."startLine",
          c."endLine",
          c."content",
          f."path"         AS "filePath",
          f."language",
          f."lastCommitSha",
          f."lastCommitMessage",
          f."lastCommitAuthor",
          f."lastCommitAt",
          (c."embedding" <=> '${embeddingLiteral}'::vector) AS distance
        FROM "CodeChunk" c
        JOIN "CodeFile" f ON f."id" = c."fileId"
        WHERE c."embedding" IS NOT NULL
        ${repoFilter}
        ORDER BY c."embedding" <=> '${embeddingLiteral}'::vector
        LIMIT ${input.topK}`,
      );

      return rows.map((row) => ({
        snippet: row.content,
        filePath: row.filePath,
        lineRange: { start: row.startLine, end: row.endLine },
        language: row.language,
        lastCommit:
          row.lastCommitSha && row.lastCommitAt
            ? {
                sha: row.lastCommitSha,
                message: row.lastCommitMessage ?? "",
                author: row.lastCommitAuthor ?? "",
                committedAt: row.lastCommitAt,
              }
            : null,
        confidenceScore: Math.max(0, Math.min(1, 1 - row.distance)),
        chunkType: row.chunkType as CodeQueryResult["chunkType"],
        symbolName: row.symbolName,
      }));
    }),

  /**
   * Return all code chunks for a specific file path within a repository.
   */
  fileLookup: publicProcedure
    .input(FileLookupSchema)
    .query(async ({ ctx, input }): Promise<CodeQueryResult[]> => {
      const file = await ctx.prisma.codeFile.findUnique({
        where: {
          repositoryId_path: {
            repositoryId: input.repoId,
            path: input.filePath,
          },
        },
        include: {
          chunks: { orderBy: { startLine: "asc" } },
        },
      });

      if (!file) return [];

      const lastCommit =
        file.lastCommitSha && file.lastCommitAt
          ? {
              sha: file.lastCommitSha,
              message: file.lastCommitMessage ?? "",
              author: file.lastCommitAuthor ?? "",
              committedAt: file.lastCommitAt,
            }
          : null;

      return file.chunks.map((chunk) => ({
        snippet: chunk.content,
        filePath: file.path,
        lineRange: { start: chunk.startLine, end: chunk.endLine },
        language: file.language,
        lastCommit,
        confidenceScore: 1,
        chunkType: chunk.chunkType as CodeQueryResult["chunkType"],
        symbolName: chunk.symbolName,
      }));
    }),

  /**
   * Return recently changed files and their latest chunks, ordered by commit time.
   */
  recentChanges: publicProcedure
    .input(RecentChangesSchema)
    .query(async ({ ctx, input }): Promise<CodeQueryResult[]> => {
      const whereRepo =
        input.repoIds && input.repoIds.length > 0
          ? { repositoryId: { in: input.repoIds } }
          : {};

      const whereSince = input.since ? { committedAt: { gte: input.since } } : {};

      const commits = await ctx.prisma.fileCommit.findMany({
        where: { ...whereSince, file: { ...whereRepo } },
        orderBy: { committedAt: "desc" },
        take: input.limit,
        include: {
          file: {
            include: {
              chunks: { orderBy: { startLine: "asc" }, take: 1 },
            },
          },
        },
      });

      return commits.flatMap((commit) => {
        const file = commit.file;
        const firstChunk = file.chunks[0];
        if (!firstChunk) return [];

        return [
          {
            snippet: firstChunk.content,
            filePath: file.path,
            lineRange: { start: firstChunk.startLine, end: firstChunk.endLine },
            language: file.language,
            lastCommit: {
              sha: commit.sha,
              message: commit.message,
              author: commit.author,
              committedAt: commit.committedAt,
            },
            confidenceScore: 1,
            chunkType: firstChunk.chunkType as CodeQueryResult["chunkType"],
            symbolName: firstChunk.symbolName,
          },
        ];
      });
    }),

  /**
   * Look up a symbol (function, class, type) by name across repositories.
   */
  symbolLookup: publicProcedure
    .input(SymbolLookupSchema)
    .query(async ({ ctx, input }): Promise<CodeQueryResult[]> => {
      const chunks = await ctx.prisma.codeChunk.findMany({
        where: {
          symbolName: { contains: input.symbolName, mode: "insensitive" },
          ...(input.chunkType ? { chunkType: input.chunkType } : {}),
          ...(input.repoIds && input.repoIds.length > 0
            ? { file: { repositoryId: { in: input.repoIds } } }
            : {}),
        },
        include: { file: true },
        orderBy: { createdAt: "asc" },
      });

      return chunks.map((chunk) => {
        const file = chunk.file;
        const lastCommit =
          file.lastCommitSha && file.lastCommitAt
            ? {
                sha: file.lastCommitSha,
                message: file.lastCommitMessage ?? "",
                author: file.lastCommitAuthor ?? "",
                committedAt: file.lastCommitAt,
              }
            : null;

        return {
          snippet: chunk.content,
          filePath: file.path,
          lineRange: { start: chunk.startLine, end: chunk.endLine },
          language: file.language,
          lastCommit,
          confidenceScore: 1,
          chunkType: chunk.chunkType as CodeQueryResult["chunkType"],
          symbolName: chunk.symbolName,
        };
      });
    }),

  /**
   * Return commit history for a file — who changed it and when.
   */
  blameOwnership: publicProcedure
    .input(BlameOwnershipSchema)
    .query(async ({ ctx, input }) => {
      const file = await ctx.prisma.codeFile.findUnique({
        where: {
          repositoryId_path: {
            repositoryId: input.repoId,
            path: input.filePath,
          },
        },
        include: {
          commits: { orderBy: { committedAt: "desc" } },
        },
      });

      if (!file) return [];

      return file.commits.map((commit) => ({
        sha: commit.sha,
        message: commit.message,
        author: commit.author,
        authorEmail: commit.authorEmail,
        committedAt: commit.committedAt,
        filePath: file.path,
      }));
    }),
});
