-- 她自己审核表达习惯：记录是谁审的、什么时候审的，便于筛选与撤销。
ALTER TABLE "character_expression_habits" ADD COLUMN "reviewedBy" VARCHAR(20);
ALTER TABLE "character_expression_habits" ADD COLUMN "reviewedAt" TIMESTAMPTZ(6);
CREATE INDEX "character_expression_habits_characterId_reviewedBy_reviewedAt_idx"
  ON "character_expression_habits"("characterId", "reviewedBy", "reviewedAt");
