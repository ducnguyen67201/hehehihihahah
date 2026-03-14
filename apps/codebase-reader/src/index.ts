/**
 * apps/codebase-reader entry point.
 *
 * This service does not expose an HTTP server — it is a library of git, parsing,
 * embedding, and indexing utilities consumed by Temporal activities in apps/queue.
 *
 * Running this file directly is a no-op outside of tests/debug scenarios.
 */

export * from "./lib/git.js";
export * from "./lib/parser.js";
export * from "./lib/embedder.js";
export * from "./lib/indexer.js";

console.log("[codebase-reader] Library loaded. No HTTP server — consumed by Temporal activities.");
