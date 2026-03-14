import { z } from "zod";

export const NodeEnvSchema = z
  .enum(["development", "test", "production"])
  .default("development");

export const TemporalAddressSchema = z.string().default("localhost:7233");
export const TemporalNamespaceSchema = z.string().default("default");
export const TemporalTaskQueueSchema = z.string().default("template-task-queue");

// ── Codebase Reader ──────────────────────────────────────────────────
export const GithubTokenSchema = z.string().min(1);
export const VoyageApiKeySchema = z.string().optional();
export const OpenAiApiKeySchema = z.string().optional();
export const CodeReposDirSchema = z.string().default("/data/repos");
export const EmbeddingModelSchema = z
  .string()
  .default("text-embedding-3-small");
export const EmbeddingDimensionsSchema = z.coerce.number().int().default(1536);
