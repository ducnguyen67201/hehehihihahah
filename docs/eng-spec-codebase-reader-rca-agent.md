# Engineering Spec: Codebase Reader for RCA Agent

## 1. Job to Be Done

**Who:** The RCA (Root Cause Analysis) agent — an automated system that investigates production bugs and incidents by correlating logs, metrics, and source code.

**What:** The agent needs a read-only code intelligence layer that lets it query source code across multiple private GitHub repositories (TypeScript, Python, Go) during a bug investigation — finding the exact function that threw an error, understanding recent changes, and identifying code ownership.

**Why:** Without code context, the RCA agent can only surface shallow summaries ("process X failed"). With it, it can produce deep root causes: "this specific commit changed function Y in file Z, which is owned by team A, and it broke contract B." The reader must be deterministic and cheap — no LLM calls, only parsing + embeddings.

**Success criteria:**
- Any function/class/symbol is retrievable from indexed repos within 500ms
- Semantic search returns relevant results with ranked confidence scores
- Differential re-indexing completes for a 1000-file repo change set within 60 seconds
- Scheduled sync detects and re-indexes changed files every 15 minutes
- Query responses always include: code snippet, file path, line range, language, last commit info, confidence score

---

## 2. Proposed Flow / Architecture

### New App: `apps/codebase-reader`

A standalone Node.js service (not Next.js) responsible for git operations, tree-sitter parsing, embedding generation, and DB writes. Exposes no HTTP surface itself — query access goes through `@shared/rest` tRPC procedures.

### Data Model Changes

Add to `packages/database/prisma/schema.prisma`:

```prisma
model TrackedRepository {
  id            String    @id @default(cuid())
  owner         String
  name          String
  branch        String    @default("main")
  clonePath     String    // absolute path on disk
  lastSyncedAt  DateTime?
  lastCommitSha String?
  isActive      Boolean   @default(true)
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt

  files CodeFile[]

  @@unique([owner, name, branch])
}

model CodeFile {
  id                String    @id @default(cuid())
  path              String    // relative to repo root
  language          String    // "typescript" | "python" | "go"
  contentHash       String    // SHA-256 for change detection
  lastCommitSha     String?
  lastCommitMessage String?
  lastCommitAuthor  String?
  lastCommitAt      DateTime?
  indexedAt         DateTime  @default(now())

  repository   TrackedRepository @relation(fields: [repositoryId], references: [id], onDelete: Cascade)
  repositoryId String

  chunks  CodeChunk[]
  commits FileCommit[]

  @@unique([repositoryId, path])
}

model CodeChunk {
  id         String    @id @default(cuid())
  chunkType  ChunkType
  symbolName String?   // function/class/type name, null for MODULE chunks
  startLine  Int
  endLine    Int
  content    String
  // pgvector column — raw SQL migration required (Unsupported in Prisma schema)
  createdAt  DateTime  @default(now())

  file   CodeFile @relation(fields: [fileId], references: [id], onDelete: Cascade)
  fileId String
}

model FileCommit {
  id          String   @id @default(cuid())
  sha         String
  message     String
  author      String
  authorEmail String
  committedAt DateTime

  file   CodeFile @relation(fields: [fileId], references: [id], onDelete: Cascade)
  fileId String

  @@unique([fileId, sha])
}

enum ChunkType {
  FUNCTION
  CLASS
  ROUTE
  TYPE
  MODULE
}
```

> **Note on pgvector:** The `embedding` column is `vector(1024)` or `vector(1536)` depending on the model. It cannot be expressed in Prisma schema syntax — add it via a raw SQL migration after `db:migrate`. Use raw SQL in tRPC procedures for similarity queries (`<=>` cosine distance operator).

### Zod Schemas (`packages/types/src/schemas/codebase.ts`)

```ts
// Input schemas
RegisterRepoSchema         // { owner, name, branch? }
SemanticSearchSchema       // { query: string (max 1000 chars), repoIds?: string[], topK?: number (default 5) }
FileLookupSchema           // { repoId: string, filePath: string }
RecentChangesSchema        // { repoIds?: string[], since?: Date, limit?: number }
SymbolLookupSchema         // { symbolName: string, chunkType?: ChunkType, repoIds?: string[] }
BlameOwnershipSchema       // { repoId: string, filePath: string }

// Shared response shape
CodeQueryResultSchema      // { snippet, filePath, lineRange: { start, end }, language, lastCommit: { sha, message, author, committedAt }, confidenceScore: number, chunkType, symbolName? }
```

### tRPC Layer (`packages/rest/src/routers/codebase.ts`)

Six procedures registered on `codebaseRouter`:

| Procedure | Input | DB Operation |
|---|---|---|
| `codebase.registerRepo` | `RegisterRepoSchema` | Create `TrackedRepository`, dispatch clone workflow |
| `codebase.semanticSearch` | `SemanticSearchSchema` | Embed query → pgvector `<=>` cosine similarity on `CodeChunk.embedding` |
| `codebase.fileLookup` | `FileLookupSchema` | Select all `CodeChunk` rows for a `CodeFile.path` |
| `codebase.recentChanges` | `RecentChangesSchema` | Join `FileCommit` + `CodeChunk` ordered by `committedAt` desc |
| `codebase.symbolLookup` | `SymbolLookupSchema` | Filter `CodeChunk` by `symbolName ILIKE` + optional `chunkType` |
| `codebase.blameOwnership` | `BlameOwnershipSchema` | Return all `FileCommit` rows for a file, ordered by `committedAt` desc |

All query procedures return `CodeQueryResult[]`. `registerRepo` is admin-only.

### Queue Integration (`apps/queue`)

**New Temporal workflow:** `syncRepositoryWorkflow` — cron schedule every 15 minutes.

**New Temporal activities:**

| Activity | Responsibility |
|---|---|
| `gitCloneActivity` | Initial `git clone` of a registered repo to `CODE_REPOS_DIR/<owner>/<name>` |
| `gitPullActivity` | Run `git pull` on an already-cloned repo, return new HEAD sha |
| `getDiffActivity` | Run `git diff <old_sha> <new_sha> --name-only`, return changed file list |
| `parseAndIndexActivity` | For a file list: tree-sitter parse → embed → delete old chunks → insert new `CodeChunk` rows |
| `fetchGitHistoryActivity` | For a file list: run `git log --follow -n 20 <file>` → upsert `FileCommit` rows |

### Flow Diagram

**Initial ingestion:**
1. Admin calls `codebase.registerRepo` with `{ owner, name, branch }`
2. tRPC creates `TrackedRepository` record in DB
3. Triggers `syncRepositoryWorkflow` via Temporal client with `initialClone: true`
4. `gitCloneActivity` clones repo to `CODE_REPOS_DIR/<owner>/<name>`
5. `parseAndIndexActivity` runs on ALL files — tree-sitter parses each file into chunks, embedding model batch-embeds, inserts `CodeFile` + `CodeChunk` rows
6. `fetchGitHistoryActivity` fetches last 20 commits per file → inserts `FileCommit` rows
7. `TrackedRepository.lastCommitSha` and `lastSyncedAt` updated

**Scheduled sync (every 15 min per active repo):**
1. Temporal cron fires `syncRepositoryWorkflow`
2. `gitPullActivity` runs `git pull`, returns new HEAD sha
3. If new sha == `lastCommitSha` → workflow exits early (no changes)
4. `getDiffActivity` computes changed file list between old and new sha
5. `parseAndIndexActivity` runs only on changed files (delete old chunks, insert new)
6. `fetchGitHistoryActivity` updates `FileCommit` records for changed files
7. `TrackedRepository.lastSyncedAt` + `lastCommitSha` updated

**RCA agent query:**
1. RCA agent calls tRPC procedure (e.g., `codebase.semanticSearch`)
2. Zod validates input
3. For semantic search: embed the query string (one embedding API call), run `SELECT ... ORDER BY embedding <=> $1 LIMIT $2` via raw SQL
4. Join `CodeFile` + `TrackedRepository` to build `CodeQueryResult[]`
5. Return structured response with snippet, path, line range, language, last commit, confidence score

### Dependencies

**New packages for `apps/codebase-reader`:**
- `tree-sitter` + `tree-sitter-typescript` + `tree-sitter-python` + `tree-sitter-go` — AST-based parsing
- `simple-git` — git clone/pull/diff/log operations
- `voyageai` or `openai` — embedding generation (Voyage `voyage-code-3` recommended for code)
- `@temporalio/client` — trigger Temporal workflows from the service

**Database extension:**
- `pgvector` Postgres extension — `CREATE EXTENSION IF NOT EXISTS vector` (raw SQL migration)
- No new ORM package needed; raw SQL via `prisma.$queryRaw` for vector operations

**New env vars (add to `packages/env/src/shared.ts`):**
- `GITHUB_TOKEN` — fine-grained PAT with `contents: read` for private repos
- `VOYAGE_API_KEY` or `OPENAI_API_KEY` — embedding model access
- `CODE_REPOS_DIR` — local path for cloned repos (e.g., `/data/repos`)
- `EMBEDDING_MODEL` — e.g., `voyage-code-3` or `text-embedding-3-small`
- `EMBEDDING_DIMENSIONS` — `1024` (Voyage) or `1536` (OpenAI) — must match vector column size

---

## 3. Task Checklist

### Schema / Data
- [ ] Add raw SQL migration to enable pgvector: `CREATE EXTENSION IF NOT EXISTS vector` — in `packages/database/prisma/migrations/`
- [ ] Add `TrackedRepository`, `CodeFile`, `CodeChunk`, `FileCommit`, `ChunkType` enum to `packages/database/prisma/schema.prisma`
- [ ] Add raw SQL migration to add `embedding vector(1024)` column to `CodeChunk` table (after `db:migrate`)
- [ ] Run `npm run db:generate` to regenerate Prisma types into `packages/types/src/prisma-generated/`
- [ ] Create `packages/types/src/schemas/codebase.ts` with all 6 input schemas + `CodeQueryResultSchema`
- [ ] Export new schemas and types from `packages/types/src/schemas/index.ts`
- [ ] Export from `packages/types/src/index.ts` — `CodeQueryResult`, `ChunkType`, and all new input types
- [ ] Run `npm run db:migrate` to apply schema changes to DB

### Backend / API
- [ ] Add new env vars to `packages/env/src/shared.ts` — `GITHUB_TOKEN`, `VOYAGE_API_KEY`/`OPENAI_API_KEY`, `CODE_REPOS_DIR`, `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS`
- [ ] Create `packages/rest/src/routers/codebase.ts` — implement all 6 procedures using `ctx.prisma`
- [ ] Implement `codebase.semanticSearch` using `ctx.prisma.$queryRaw` with pgvector cosine similarity
- [ ] Register `codebaseRouter` in `packages/rest/src/root.ts`
- [ ] Create `apps/codebase-reader/` directory with `package.json`, `tsconfig.json` extending `@shared/tsconfig/library.json`
- [ ] Create `apps/codebase-reader/src/lib/git.ts` — `cloneRepo`, `pullRepo`, `getDiff`, `getFileHistory` using `simple-git`
- [ ] Create `apps/codebase-reader/src/lib/parser.ts` — tree-sitter AST parsing for TS/Python/Go, returns `Array<{ chunkType, symbolName, startLine, endLine, content }>`
- [ ] Create `apps/codebase-reader/src/lib/embedder.ts` — batch embed `string[]` via Voyage/OpenAI SDK, returns `number[][]`
- [ ] Create `apps/codebase-reader/src/lib/indexer.ts` — orchestrates parse → embed → upsert `CodeFile` + `CodeChunk` rows in Prisma
- [ ] Create `apps/queue/src/activities/git-clone.activity.ts` — wraps `cloneRepo` from codebase-reader lib
- [ ] Create `apps/queue/src/activities/git-pull.activity.ts` — wraps `pullRepo`, returns new HEAD sha
- [ ] Create `apps/queue/src/activities/get-diff.activity.ts` — wraps `getDiff`, returns changed file paths
- [ ] Create `apps/queue/src/activities/parse-and-index.activity.ts` — wraps `indexer.ts` for a given file list
- [ ] Create `apps/queue/src/activities/fetch-git-history.activity.ts` — wraps `getFileHistory`, upserts `FileCommit` rows
- [ ] Register all 5 new activities in `apps/queue/src/activities/index.ts`
- [ ] Create `apps/queue/src/workflows/sync-repository.workflow.ts` — orchestrates all activities, handles initial clone vs incremental diff
- [ ] Register `syncRepositoryWorkflow` in `apps/queue/src/workflows/index.ts` and `registry.ts`
- [ ] Add Temporal cron schedule for `syncRepositoryWorkflow` (every 15 min) in `apps/queue/src/worker.ts`

### Frontend / UI
- [ ] _(V1 API-only — no frontend needed for query interface)_
- [ ] _(Optional)_ Add `RepoRegistrationForm` component in `apps/web/src/components/admin/` for registering repos via `codebase.registerRepo`

### Wiring
- [ ] Verify `apps/codebase-reader` is picked up by root `package.json` workspaces (`"apps/*"` already covers it)
- [ ] Add `turbo.json` pipeline entries for `apps/codebase-reader` build/dev scripts
- [ ] Create `apps/codebase-reader/Dockerfile` mirroring `apps/queue/Dockerfile` pattern
- [ ] Create `.github/workflows/build-codebase-reader.yml` — runs `db:generate`, `type-check`, `lint`, `build --workspace @app/codebase-reader`
- [ ] Add `GITHUB_TOKEN`, `VOYAGE_API_KEY`, `CODE_REPOS_DIR`, `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS` to `.env.example`

### Cleanup
- [ ] Update `CLAUDE.md` — document `codebaseRouter` in `@shared/rest`, `apps/codebase-reader` app, and new env vars
- [ ] Update `CLAUDE.md` — document pgvector raw SQL pattern for similarity queries

---

## 4. Testing Checklist

### Happy Path
- [ ] Register a public GitHub repo → verify `TrackedRepository` record created, clone activity runs, files indexed with embeddings in `CodeChunk` table
- [ ] Semantic search with a natural language query returns 5 `CodeQueryResult` items, each with non-null `confidenceScore`, `snippet`, `filePath`, and `lastCommit`
- [ ] File lookup by exact path returns all chunks for that file with correct `startLine`/`endLine` ranges
- [ ] Recent changes returns files modified within the `since` window, ordered newest first
- [ ] Symbol lookup by function name returns correct chunk with `chunkType: FUNCTION` and matching `symbolName`
- [ ] Blame/ownership returns up to 20 commits for a given file path, ordered by `committedAt` desc
- [ ] After a simulated git push (add a commit to tracked repo), next sync cycle re-indexes only changed files and leaves unchanged `CodeChunk` records untouched

### Validation
- [ ] `registerRepo` with duplicate `owner/name/branch` returns a descriptive conflict error (not 500)
- [ ] `semanticSearch` with query over 1000 characters is rejected by Zod with clear error message
- [ ] `fileLookup` for a path that doesn't exist in the index returns empty array (not error)
- [ ] `symbolLookup` with empty `symbolName` string is rejected by Zod
- [ ] `blameOwnership` with a non-existent `repoId` returns empty array

### Edge Cases
- [ ] Repo with no parseable files (all binary/ignored) — ingestion completes gracefully, `lastSyncedAt` is updated, zero `CodeChunk` rows inserted
- [ ] File deleted from repo between syncs — old `CodeChunk` rows are removed on next sync
- [ ] File renamed between syncs — old path's chunks are deleted, new path's chunks are inserted
- [ ] Single file exceeding 10,000 lines — parser does not OOM; either chunked or skipped with a logged warning
- [ ] Private repo with expired `GITHUB_TOKEN` — `gitCloneActivity` fails with descriptive error; Temporal retries with exponential backoff; alert after max retries
- [ ] Embedding API rate limit (429 response) — `embedder.ts` retries with backoff; Temporal activity heartbeats kept alive
- [ ] Concurrent `syncRepositoryWorkflow` for same repo — Temporal workflow ID deduplication ensures only one run at a time per repo

### Auth / Permissions
- [ ] `codebase.registerRepo` called by non-admin user returns `UNAUTHORIZED` tRPC error
- [ ] Query procedures (`semanticSearch`, `fileLookup`, etc.) require a valid session token or service API key
- [ ] `GITHUB_TOKEN` is never included in any tRPC response payload
- [ ] `clonePath` (local disk path) is never returned to API callers — only `filePath` relative to repo root

### Type Safety
- [ ] `npm run type-check` passes across all packages after adding new Prisma models and Zod schemas
- [ ] `CodeQueryResult` type used by tRPC response matches the type expected by the RCA agent consumer
- [ ] `Unsupported` pgvector column in Prisma schema does not break generated types or client operations

### Lint + Build
- [ ] `npm run lint` passes with no new violations in `packages/rest`, `packages/types`, `apps/codebase-reader`, `apps/queue`
- [ ] `npm run build` succeeds for all apps including `apps/codebase-reader`
- [ ] `apps/queue` builds successfully with all 5 new activity registrations and new workflow export
- [ ] `build-codebase-reader.yml` CI workflow passes end-to-end
