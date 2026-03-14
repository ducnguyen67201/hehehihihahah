# Codebase Reader — Workflow & Developer Guide

This document explains how the Codebase Reader works end-to-end and how to use
it from other features in this monorepo (RCA workflow, Discord bot, auto-PR, etc.).

---

## 1. What It Does

The Codebase Reader is a background indexing service that:

1. **Clones** tracked GitHub repositories to local disk
2. **Parses** every TypeScript / Python / Go file into named code chunks (functions, classes, types)
3. **Embeds** each chunk using Voyage AI or OpenAI to produce a `vector(1024|1536)`
4. **Stores** chunks and git commit history in Postgres
5. **Re-indexes** every 15 minutes via a Temporal cron workflow

The result is a queryable knowledge base of *live source code* that any feature can
call through tRPC without understanding git, embeddings, or tree-sitter.

---

## 2. Full Pipeline (how it actually runs)

```
Admin calls codebase.registerRepo
           │
           ▼
  TrackedRepository row created in DB
           │
           ▼
  syncRepositoryWorkflow triggered (Temporal)
    │  initialClone=true
    │
    ├─ gitCloneActivity
    │    simple-git clone → CODE_REPOS_DIR/<owner>/<name>
    │
    ├─ gitPullActivity
    │    returns HEAD sha after clone
    │
    ├─ getDiffActivity
    │    git diff <empty-tree> <HEAD> --name-only
    │    → list of every file in repo
    │
    ├─ parseAndIndexActivity        ← heartbeats every 10 files
    │    for each file:
    │      detectLanguage (ts/py/go only, skip rest)
    │      readFile + sha256 content hash
    │      skip if contentHash unchanged (incremental re-index)
    │      tree-sitter parse → ParsedChunk[]
    │        (falls back to single MODULE chunk on parse failure)
    │      embedBatch via Voyage / OpenAI
    │      DELETE old CodeChunk rows for this file
    │      INSERT new CodeChunk rows with vector embeddings
    │      UPSERT CodeFile row (path, language, contentHash, lastCommit*)
    │
    ├─ fetchGitHistoryActivity
    │    git log --follow -n 20 <file>
    │    UPSERT FileCommit rows (sha, message, author, committedAt)
    │    UPDATE CodeFile.lastCommitSha/Author/Message/At
    │
    └─ updateRepoSyncState
         UPDATE TrackedRepository.lastCommitSha, lastSyncedAt

── Every 15 min (Temporal cron) ───────────────────────────────────
  syncRepositoryWorkflow (initialClone=false)
    ├─ gitPullActivity → newHeadSha
    ├─ if newHeadSha == lastCommitSha → exit early (no changes)
    ├─ getDiffActivity oldSha..newSha → changedFiles only
    ├─ parseAndIndexActivity (changed files only)
    ├─ fetchGitHistoryActivity (changed files only)
    └─ updateRepoSyncState
```

---

## 3. Data Model (what lives in Postgres)

```
TrackedRepository
  id            cuid
  owner         "TexWard45"
  name          "my-scenario-generator"
  branch        "main"
  clonePath     "/data/repos/TexWard45/my-scenario-generator"  ← never exposed to callers
  lastCommitSha sha of last indexed commit
  lastSyncedAt  timestamp of last sync
  isActive      bool

CodeFile
  id            cuid
  repositoryId  → TrackedRepository.id
  path          "src/lib/generator.ts"   ← relative, repo-root only
  language      "typescript" | "python" | "go"
  contentHash   sha256 of file content
  lastCommitSha / lastCommitMessage / lastCommitAuthor / lastCommitAt

CodeChunk
  id            cuid
  fileId        → CodeFile.id
  chunkType     FUNCTION | CLASS | ROUTE | TYPE | MODULE
  symbolName    "generateScenario" | null (MODULE chunks have no name)
  startLine     1-based line number
  endLine       1-based line number
  content       raw source text of the chunk
  embedding     vector(1024) or vector(1536)   ← pgvector column, raw SQL only

FileCommit
  id            cuid
  fileId        → CodeFile.id
  sha           full git sha
  message       commit message
  author        "Nhat Anh"
  authorEmail   "nhat@example.com"
  committedAt   timestamp
```

---

## 4. Query API — tRPC `codebase.*`

Import from `@shared/rest` on the server side. All procedures return `CodeQueryResult[]`
(except `registerRepo` and `blameOwnership`).

```ts
import type { CodeQueryResult } from "@shared/types";
```

### `CodeQueryResult` shape

```ts
type CodeQueryResult = {
  snippet:         string;          // raw source code of the chunk
  filePath:        string;          // relative path, e.g. "src/lib/generator.ts"
  lineRange:       { start: number; end: number };
  language:        string;          // "typescript" | "python" | "go"
  lastCommit:      {
    sha:         string;
    message:     string;
    author:      string;
    committedAt: Date;
  } | null;
  confidenceScore: number;          // 0–1; cosine similarity for semantic search, 1 for exact lookups
  chunkType:       "FUNCTION" | "CLASS" | "ROUTE" | "TYPE" | "MODULE";
  symbolName:      string | null;
};
```

---

### Procedure reference

#### `codebase.registerRepo` — register a new repo (admin only)

```ts
// Input
{ owner: string; name: string; branch?: string }

// Returns
{ id: string; owner: string; name: string; branch: string; createdAt: Date }

// Creates TrackedRepository row + triggers syncRepositoryWorkflow (initialClone=true)
```

---

#### `codebase.semanticSearch` — find relevant code by description

Best for: **RCA workflow** finding what code is related to an error message or symptom.

```ts
// Input
{
  query:   string;         // natural language or error text, max 1000 chars
  repoIds?: string[];      // filter to specific repos; omit for all
  topK?:   number;         // 1–50, default 5
}

// Returns CodeQueryResult[] ordered by cosine similarity (confidenceScore desc)
```

Example — Duc's RCA workflow finding the function behind an error:

```ts
import { createCaller } from "@shared/rest";

const caller = createCaller(ctx);

const results = await caller.codebase.semanticSearch({
  query: "TypeError: Cannot read properties of undefined reading 'scenarioId'",
  repoIds: [repositoryId],
  topK: 5,
});

// results[0].snippet → the most relevant function
// results[0].filePath → "src/lib/generator.ts"
// results[0].lastCommit → who last touched it and when
// results[0].confidenceScore → 0.87 (cosine similarity)
```

---

#### `codebase.symbolLookup` — find a function or class by name

Best for: **auto-PR add-on** (Task 6) finding the exact function to patch, or **RCA** following a stack trace symbol.

```ts
// Input
{
  symbolName: string;              // partial match, case-insensitive ILIKE
  chunkType?: "FUNCTION" | "CLASS" | "ROUTE" | "TYPE";
  repoIds?:   string[];
}

// Returns CodeQueryResult[]
```

Example — finding `generateScenario` to understand its implementation:

```ts
const results = await caller.codebase.symbolLookup({
  symbolName: "generateScenario",
  chunkType: "FUNCTION",
  repoIds: [repositoryId],
});
// results[0].snippet → full function source
// results[0].lineRange → { start: 42, end: 87 }
```

---

#### `codebase.fileLookup` — get all chunks for a specific file

Best for: **auto-PR** (Task 6) reading the full file before writing a patch, or understanding a module.

```ts
// Input
{ repoId: string; filePath: string }   // filePath is repo-relative

// Returns CodeQueryResult[] ordered by startLine, confidenceScore=1
```

Example:

```ts
const chunks = await caller.codebase.fileLookup({
  repoId: repositoryId,
  filePath: "src/lib/generator.ts",
});
// Full file reconstructable from chunks[i].snippet ordered by lineRange.start
```

---

#### `codebase.recentChanges` — files changed in a time window

Best for: **RCA workflow** (Task 4) correlating an incident time with recent deploys.
Best for: **stats/events** (Task 3) enriching an event with "what changed near this timestamp".

```ts
// Input
{
  repoIds?: string[];
  since?:   Date;           // default: no lower bound
  limit?:   number;         // 1–100, default 20
}

// Returns CodeQueryResult[] ordered by committedAt desc
```

Example — Duc's RCA checking what changed in the last hour:

```ts
const recentFiles = await caller.codebase.recentChanges({
  repoIds: [repositoryId],
  since: new Date(Date.now() - 60 * 60 * 1000), // 1 hour ago
  limit: 10,
});
// recentFiles[0].lastCommit.message → "fix: handle null scenarioId"
// recentFiles[0].filePath → "src/lib/generator.ts"
```

---

#### `codebase.blameOwnership` — who last touched a file and when

Best for: **RCA** (Task 4) routing an escalation to the likely code owner.
Best for: **auto-PR** (Task 6) deciding who to assign the PR to.

```ts
// Input
{ repoId: string; filePath: string }

// Returns
Array<{
  sha:         string;
  message:     string;
  author:      string;
  authorEmail: string;
  committedAt: Date;
  filePath:    string;
}>
```

Example — finding the engineer to ping:

```ts
const commits = await caller.codebase.blameOwnership({
  repoId: repositoryId,
  filePath: "src/lib/generator.ts",
});
// commits[0].author → "Nhat Anh"
// commits[0].authorEmail → "nhat@example.com"
```

---

## 5. How Each Feature Should Use This

### Task 4 — RCA Workflow (Duc)

The RCA workflow calls the codebase layer in two places:

**a. `searchCodebaseActivity`** — after extracting intent, search for relevant code:

```ts
// Inside the activity
const caller = createCaller(ctx);
const snippets = await caller.codebase.semanticSearch({
  query: `${errorMessage} ${stackTraceLine}`,
  repoIds: activeRepoIds,
  topK: 5,
});
// Attach snippets to the RCA investigation context sent to Claude
```

**b. `findOwnerActivity`** — after identifying the root-cause file, find the owner:

```ts
const commits = await caller.codebase.blameOwnership({
  repoId: repoId,
  filePath: rootCauseFilePath,
});
const likelyOwner = commits[0]?.author;   // route Linear ticket to this person
const recentCommitter = commits[0]?.authorEmail;
```

**c. `recentDeployCorrelation`** — check if a deploy happened near incident time:

```ts
const recentChanges = await caller.codebase.recentChanges({
  repoIds: activeRepoIds,
  since: new Date(incidentStartedAt.getTime() - 30 * 60 * 1000),
  limit: 20,
});
// If recentChanges.length > 0 → "recent deploy" is a likely contributing factor
```

---

### Task 2 — Discord Bot (LU)

When a support message arrives, before calling Claude for a reply, enrich
the prompt with codebase context:

```ts
// In the Discord message handler
const caller = createCaller(ctx);
const codeContext = await caller.codebase.semanticSearch({
  query: discordMessage.content,
  topK: 3,
});

const prompt = `
Support message: ${discordMessage.content}

Relevant source code:
${codeContext.map(r => `// ${r.filePath} (${r.chunkType} ${r.symbolName ?? ""})\n${r.snippet}`).join("\n\n")}

Draft a helpful reply.
`;
// Pass prompt to Claude → post reply to Discord thread
```

---

### Task 6 — Auto PR / Refactor Add-on

Uses `symbolLookup` + `fileLookup` to read the code, then posts a GitHub PR.

```ts
// Step 1: find the exact function to fix (from RCA output)
const [chunk] = await caller.codebase.symbolLookup({
  symbolName: rcaOutput.rootCauseSymbol,
  chunkType: "FUNCTION",
  repoIds: [repoId],
});

// Step 2: read the full file for context
const fileChunks = await caller.codebase.fileLookup({
  repoId,
  filePath: chunk.filePath,
});

// Step 3: send to Claude with patch instruction
const patch = await claude.generatePatch({
  file: fileChunks.map(c => c.snippet).join("\n"),
  issue: rcaOutput.summary,
  targetSymbol: chunk.symbolName,
  lineRange: chunk.lineRange,
});

// Step 4: GitHub API → create branch + PR
await github.createPR({ filePath: chunk.filePath, patch, owner: chunk.lastCommit?.author });
```

---

## 6. Registering a New Repo

`registerRepo` now does everything in one call:
1. Creates the `TrackedRepository` DB row
2. Starts `syncRepositoryWorkflow` immediately (`initialClone: true`) — clones the repo and indexes all files
3. Creates a Temporal cron schedule for ongoing 15-min syncs

No manual follow-up steps needed.

### Via tRPC (production)

```ts
const repo = await caller.codebase.registerRepo({
  owner: "TexWard45",
  name: "my-scenario-generator",
  branch: "main",
});
// repo.id — use this as repoId in all query procedures
// Monitor clone progress at http://localhost:8233
```

### Via script (dev / one-off)

```bash
npx tsx scripts/register-repo.ts <owner> <name> [branch]
npx tsx scripts/trigger-sync.ts <owner> <name> [branch]  # only needed for manual re-sync
```

### Multiple branches of the same repo

Each branch is an independent `TrackedRepository` with its own clone directory:

```
CODE_REPOS_DIR/
  TexWard45/
    my-scenario-generator/
      main/       ← branch "main"
      staging/    ← branch "staging"
```

```ts
await caller.codebase.registerRepo({ owner: "TexWard45", name: "my-scenario-generator", branch: "main" });
await caller.codebase.registerRepo({ owner: "TexWard45", name: "my-scenario-generator", branch: "staging" });
```

Query across both branches by passing both `repoIds`:

```ts
const results = await caller.codebase.semanticSearch({
  query: "error handling in scenario generation",
  repoIds: [mainRepoId, stagingRepoId],
  topK: 5,
});
```

Or omit `repoIds` entirely to search across **all** registered repos.

---

## 7. Environment Variables Required

All managed via `packages/env/src/codebase-reader.ts`.

| Variable | Description | Example |
|---|---|---|
| `DATABASE_URL` | Postgres connection string | `postgresql://user:pass@localhost:5432/mydb` |
| `GITHUB_TOKEN` | Fine-grained PAT, `contents: read` scope | `ghp_...` |
| `VOYAGE_API_KEY` | Voyage AI key (preferred for code) | `pa-...` |
| `OPENAI_API_KEY` | OpenAI fallback for embeddings | `sk-...` |
| `EMBEDDING_MODEL` | Which model to use | `voyage-code-3` or `text-embedding-3-small` |
| `EMBEDDING_DIMENSIONS` | Must match the pgvector column size | `1024` (Voyage) or `1536` (OpenAI) |
| `CODE_REPOS_DIR` | Local path where repos are cloned | `/data/repos` or `D:/repos` |
| `TEMPORAL_ADDRESS` | Temporal server address | `localhost:7233` |
| `TEMPORAL_TASK_QUEUE` | Task queue name | `template-task-queue` |

---

## 8. Currently Indexed Repos

| Repo | Branch | Files | Chunks | Embeddings | Last Synced |
|---|---|---|---|---|---|
| `TexWard45/my-scenario-generator` | `main` | 166 | 166 | 166 | 2026-03-14T01:16Z |

Add more repos via `scripts/register-repo.ts` or `codebase.registerRepo`.

---

## 9. Testing

```bash
# Runs happy path, validation, edge cases, and symbol lookup checks
npx tsx scripts/test-codebase-reader.ts
```

Prerequisites: Postgres running, queue worker running, and at least one repo indexed.

See `docs/eng-spec-codebase-reader-rca-agent.md` for the full test checklist.
