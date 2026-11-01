-- CreateEnum
CREATE TYPE "JournalTextKind" AS ENUM ('DIARY', 'HANDBOOK');

-- AlterTable
ALTER TABLE "journal_revisions"
    ADD COLUMN "kind" "JournalTextKind" NOT NULL DEFAULT 'DIARY',
    ADD COLUMN "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN "sourceDiaryRevisionId" UUID;

-- DropIndex (旧的「一天只有一个版本号」约束；现在按 kind 各自排版本)
DROP INDEX "journal_revisions_journalId_version_key";
DROP INDEX "journal_revisions_journalId_version_idx";

-- CreateIndex
CREATE UNIQUE INDEX "journal_revisions_journalId_kind_version_key" ON "journal_revisions"("journalId", "kind", "version");
CREATE INDEX "journal_revisions_journalId_kind_version_idx" ON "journal_revisions"("journalId", "kind", "version");

-- AddForeignKey
ALTER TABLE "journal_revisions" ADD CONSTRAINT "journal_revisions_sourceDiaryRevisionId_fkey" FOREIGN KEY ("sourceDiaryRevisionId") REFERENCES "journal_revisions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
