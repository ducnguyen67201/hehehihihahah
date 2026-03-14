import { createEnv } from "@t3-oss/env-core";
import {
  NodeEnvSchema,
  TemporalAddressSchema,
  TemporalNamespaceSchema,
  TemporalTaskQueueSchema,
  GithubTokenSchema,
  VoyageApiKeySchema,
  OpenAiApiKeySchema,
  CodeReposDirSchema,
  EmbeddingModelSchema,
  EmbeddingDimensionsSchema,
} from "./shared";

export const codebaseReaderEnv = createEnv({
  server: {
    NODE_ENV: NodeEnvSchema,
    TEMPORAL_ADDRESS: TemporalAddressSchema,
    TEMPORAL_NAMESPACE: TemporalNamespaceSchema,
    TEMPORAL_TASK_QUEUE: TemporalTaskQueueSchema,
    GITHUB_TOKEN: GithubTokenSchema,
    VOYAGE_API_KEY: VoyageApiKeySchema,
    OPENAI_API_KEY: OpenAiApiKeySchema,
    CODE_REPOS_DIR: CodeReposDirSchema,
    EMBEDDING_MODEL: EmbeddingModelSchema,
    EMBEDDING_DIMENSIONS: EmbeddingDimensionsSchema,
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
