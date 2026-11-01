-- 每份文本的生成决策状态：整天 status 不能表达「日记写了、手账被 SKIP」。
CREATE TYPE "JournalTextState" AS ENUM ('PENDING', 'GENERATED', 'SKIPPED');

ALTER TABLE "character_journals"
  ADD COLUMN "diaryState" "JournalTextState" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "handbookState" "JournalTextState" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "diaryDecidedAt" TIMESTAMP(6) WITH TIME ZONE,
  ADD COLUMN "handbookDecidedAt" TIMESTAMP(6) WITH TIME ZONE;

-- 已有版本回填为 GENERATED；没有版本的 SKIPPED 日回填为两份都 SKIPPED，
-- 这样新调度器不会把历史「没什么可写」当成还没评估过。
UPDATE "character_journals" AS j
SET
  "diaryState" = 'GENERATED',
  "diaryDecidedAt" = COALESCE((
    SELECT MAX(r."createdAt") FROM "journal_revisions" AS r
    WHERE r."journalId" = j."id" AND r."kind" = 'DIARY'
  ), j."updatedAt")
WHERE EXISTS (
  SELECT 1 FROM "journal_revisions" AS r
  WHERE r."journalId" = j."id" AND r."kind" = 'DIARY'
);

UPDATE "character_journals" AS j
SET
  "handbookState" = 'GENERATED',
  "handbookDecidedAt" = COALESCE((
    SELECT MAX(r."createdAt") FROM "journal_revisions" AS r
    WHERE r."journalId" = j."id" AND r."kind" = 'HANDBOOK'
  ), j."updatedAt")
WHERE EXISTS (
  SELECT 1 FROM "journal_revisions" AS r
  WHERE r."journalId" = j."id" AND r."kind" = 'HANDBOOK'
);

UPDATE "character_journals" AS j
SET
  "diaryState" = 'SKIPPED',
  "handbookState" = 'SKIPPED',
  "diaryDecidedAt" = j."updatedAt",
  "handbookDecidedAt" = j."updatedAt"
WHERE j."status" = 'SKIPPED'
  AND NOT EXISTS (
    SELECT 1 FROM "journal_revisions" AS r WHERE r."journalId" = j."id"
  );

-- 手账任务显式参数：不再靠幂等键最后一个冒号后的字段推断日期 / 目标。
ALTER TABLE "memory_jobs"
  ADD COLUMN "journalDayKey" VARCHAR(10),
  ADD COLUMN "journalTarget" VARCHAR(20);
