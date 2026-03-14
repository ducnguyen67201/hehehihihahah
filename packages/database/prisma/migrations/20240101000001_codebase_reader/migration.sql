-- CreateEnum
CREATE TYPE "ChunkType" AS ENUM ('FUNCTION', 'CLASS', 'ROUTE', 'TYPE', 'MODULE');

-- CreateTable
CREATE TABLE "TrackedRepository" (
    "id" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "branch" TEXT NOT NULL DEFAULT 'main',
    "clonePath" TEXT NOT NULL,
    "lastSyncedAt" TIMESTAMP(3),
    "lastCommitSha" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrackedRepository_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CodeFile" (
    "id" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "lastCommitSha" TEXT,
    "lastCommitMessage" TEXT,
    "lastCommitAuthor" TEXT,
    "lastCommitAt" TIMESTAMP(3),
    "indexedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "repositoryId" TEXT NOT NULL,

    CONSTRAINT "CodeFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CodeChunk" (
    "id" TEXT NOT NULL,
    "chunkType" "ChunkType" NOT NULL,
    "symbolName" TEXT,
    "startLine" INTEGER NOT NULL,
    "endLine" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fileId" TEXT NOT NULL,

    CONSTRAINT "CodeChunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FileCommit" (
    "id" TEXT NOT NULL,
    "sha" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "author" TEXT NOT NULL,
    "authorEmail" TEXT NOT NULL,
    "committedAt" TIMESTAMP(3) NOT NULL,
    "fileId" TEXT NOT NULL,

    CONSTRAINT "FileCommit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TrackedRepository_owner_name_branch_key" ON "TrackedRepository"("owner", "name", "branch");

-- CreateIndex
CREATE UNIQUE INDEX "CodeFile_repositoryId_path_key" ON "CodeFile"("repositoryId", "path");

-- CreateIndex
CREATE UNIQUE INDEX "FileCommit_fileId_sha_key" ON "FileCommit"("fileId", "sha");

-- AddForeignKey
ALTER TABLE "CodeFile" ADD CONSTRAINT "CodeFile_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "TrackedRepository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CodeChunk" ADD CONSTRAINT "CodeChunk_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "CodeFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FileCommit" ADD CONSTRAINT "FileCommit_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "CodeFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
