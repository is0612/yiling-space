ALTER TABLE "reflection_runs" ADD COLUMN "conversationId" UUID, ADD COLUMN "memoryScopeId" UUID;
ALTER TABLE "reflection_runs" ADD CONSTRAINT "reflection_runs_scope_pair" CHECK (("conversationId" IS NULL) = ("memoryScopeId" IS NULL)), ADD CONSTRAINT "reflection_runs_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "character_expression_habits" ADD COLUMN "conversationId" UUID, ADD COLUMN "memoryScopeId" UUID;
ALTER TABLE "character_expression_habits" ADD CONSTRAINT "character_expression_habits_scope_pair" CHECK (("conversationId" IS NULL) = ("memoryScopeId" IS NULL)), ADD CONSTRAINT "character_expression_habits_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "character_expression_habit_revisions" ADD COLUMN "conversationId" UUID, ADD COLUMN "memoryScopeId" UUID;
ALTER TABLE "character_expression_habit_revisions" ADD CONSTRAINT "character_expression_habit_revisions_scope_pair" CHECK (("conversationId" IS NULL) = ("memoryScopeId" IS NULL));
ALTER TABLE "character_expression_habits" DROP CONSTRAINT "character_expression_habits_source_check";
ALTER TABLE "character_expression_habits" ADD CONSTRAINT "character_expression_habits_source_check" CHECK (
  jsonb_typeof("sourceRefs") = 'array' AND (
    ("sourceType" = 'MANUAL' AND jsonb_array_length("sourceRefs") = 0 AND "conversationId" IS NULL AND "memoryScopeId" IS NULL)
    OR ("sourceType" = 'SOURCES' AND jsonb_array_length("sourceRefs") BETWEEN 1 AND 5 AND "conversationId" IS NULL AND "memoryScopeId" IS NULL)
    OR ("sourceType" = 'EXPERIENCE_REFLECT' AND jsonb_array_length("sourceRefs") BETWEEN 3 AND 30 AND "conversationId" IS NOT NULL AND "memoryScopeId" IS NOT NULL)
  )
);
