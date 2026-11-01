-- CreateEnum
CREATE TYPE "JournalStatus" AS ENUM ('ACTIVE', 'SKIPPED');

-- CreateEnum
CREATE TYPE "JournalRevisionType" AS ENUM ('AI_GENERATED', 'AI_REWRITE', 'USER_EDITED', 'RESTORED');

-- AlterEnum
ALTER TYPE "MemoryJobType" ADD VALUE 'GENERATE_JOURNAL';

-- CreateTable
CREATE TABLE "character_journals" (
    "id" UUID NOT NULL,
    "memoryScopeId" UUID NOT NULL,
    "dayKey" VARCHAR(10) NOT NULL,
    "status" "JournalStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "character_journals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_revisions" (
    "id" UUID NOT NULL,
    "journalId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "title" VARCHAR(120),
    "content" TEXT NOT NULL,
    "thought" TEXT,
    "quote" TEXT,
    "sourceMessageIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sourceEventIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "revisionType" "JournalRevisionType" NOT NULL,
    "promptVersion" VARCHAR(80),
    "model" VARCHAR(120),
    "editedByUserId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "journal_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "character_journals_memoryScopeId_dayKey_key" ON "character_journals"("memoryScopeId", "dayKey");

-- CreateIndex
CREATE INDEX "character_journals_memoryScopeId_dayKey_idx" ON "character_journals"("memoryScopeId", "dayKey");

-- CreateIndex
CREATE UNIQUE INDEX "journal_revisions_journalId_version_key" ON "journal_revisions"("journalId", "version");

-- CreateIndex
CREATE INDEX "journal_revisions_journalId_version_idx" ON "journal_revisions"("journalId", "version");

-- AddForeignKey
ALTER TABLE "character_journals" ADD CONSTRAINT "character_journals_memoryScopeId_fkey" FOREIGN KEY ("memoryScopeId") REFERENCES "memory_scopes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_revisions" ADD CONSTRAINT "journal_revisions_journalId_fkey" FOREIGN KEY ("journalId") REFERENCES "character_journals"("id") ON DELETE CASCADE ON UPDATE CASCADE;
