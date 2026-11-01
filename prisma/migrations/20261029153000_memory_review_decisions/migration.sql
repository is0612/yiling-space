-- 人工对「重新提炼提出的长期记忆变化」的处置结果。
-- 单独建表而不回写 memory_snapshots.structuredContent：快照是审计产物，人的决定不该覆盖它。

CREATE TYPE "MemoryReviewDecision" AS ENUM ('ACCEPTED', 'IGNORED');

CREATE TABLE "memory_reviews" (
    "id" UUID NOT NULL,
    "snapshotId" UUID NOT NULL,
    "changeIndex" INTEGER NOT NULL,
    "decision" "MemoryReviewDecision" NOT NULL,
    "memoryItemId" UUID,
    "outcome" VARCHAR(40),
    "decidedByUserId" UUID NOT NULL,
    "decidedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_reviews_pkey" PRIMARY KEY ("id")
);

-- 同一条建议只能被处理一次，重放/双击由数据库兜底。
CREATE UNIQUE INDEX "memory_reviews_snapshotId_changeIndex_key" ON "memory_reviews"("snapshotId", "changeIndex");
CREATE INDEX "memory_reviews_snapshotId_decision_idx" ON "memory_reviews"("snapshotId", "decision");

ALTER TABLE "memory_reviews"
    ADD CONSTRAINT "memory_reviews_snapshotId_fkey"
    FOREIGN KEY ("snapshotId") REFERENCES "memory_snapshots"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
