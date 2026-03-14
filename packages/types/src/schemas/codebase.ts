import { z } from "zod";

// ── Enums ────────────────────────────────────────────────────────────

export const ChunkTypeSchema = z.enum([
  "FUNCTION",
  "CLASS",
  "ROUTE",
  "TYPE",
  "MODULE",
]);
export type ChunkTypeInput = z.infer<typeof ChunkTypeSchema>;

// ── Input Schemas ────────────────────────────────────────────────────

export const RegisterRepoSchema = z.object({
  owner: z.string().min(1),
  name: z.string().min(1),
  branch: z.string().default("main"),
});
export type RegisterRepoInput = z.infer<typeof RegisterRepoSchema>;

export const SemanticSearchSchema = z.object({
  query: z.string().min(1).max(1000),
  repoIds: z.array(z.string()).optional(),
  topK: z.number().int().min(1).max(50).default(5),
});
export type SemanticSearchInput = z.infer<typeof SemanticSearchSchema>;

export const FileLookupSchema = z.object({
  repoId: z.string().min(1),
  filePath: z.string().min(1),
});
export type FileLookupInput = z.infer<typeof FileLookupSchema>;

export const RecentChangesSchema = z.object({
  repoIds: z.array(z.string()).optional(),
  since: z.coerce.date().optional(),
  limit: z.number().int().min(1).max(100).default(20),
});
export type RecentChangesInput = z.infer<typeof RecentChangesSchema>;

export const SymbolLookupSchema = z.object({
  symbolName: z.string().min(1),
  chunkType: ChunkTypeSchema.optional(),
  repoIds: z.array(z.string()).optional(),
});
export type SymbolLookupInput = z.infer<typeof SymbolLookupSchema>;

export const BlameOwnershipSchema = z.object({
  repoId: z.string().min(1),
  filePath: z.string().min(1),
});
export type BlameOwnershipInput = z.infer<typeof BlameOwnershipSchema>;

// ── Response Schema ──────────────────────────────────────────────────

export const LastCommitSchema = z.object({
  sha: z.string(),
  message: z.string(),
  author: z.string(),
  committedAt: z.date(),
});
export type LastCommit = z.infer<typeof LastCommitSchema>;

export const CodeQueryResultSchema = z.object({
  snippet: z.string(),
  filePath: z.string(),
  lineRange: z.object({
    start: z.number().int(),
    end: z.number().int(),
  }),
  language: z.string(),
  lastCommit: LastCommitSchema.nullable(),
  confidenceScore: z.number().min(0).max(1),
  chunkType: ChunkTypeSchema,
  symbolName: z.string().nullable(),
});
export type CodeQueryResult = z.infer<typeof CodeQueryResultSchema>;
