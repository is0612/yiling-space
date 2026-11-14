ALTER TABLE "character_expression_habits" ADD COLUMN "chatScope" VARCHAR(10) NOT NULL DEFAULT 'ALL';
ALTER TABLE "character_expression_habit_revisions" ADD COLUMN "chatScope" VARCHAR(10) NOT NULL DEFAULT 'ALL';
ALTER TABLE "character_expression_habits" ADD CONSTRAINT "character_expression_habits_chat_scope_check" CHECK ("chatScope" IN ('ALL','GROUP','PRIVATE') AND NOT ("sourceType" = 'EXPERIENCE_REFLECT' AND "chatScope" = 'GROUP'));
ALTER TABLE "character_expression_habit_revisions" ADD CONSTRAINT "character_expression_habit_revisions_chat_scope_check" CHECK ("chatScope" IN ('ALL','GROUP','PRIVATE') AND NOT ("sourceType" = 'EXPERIENCE_REFLECT' AND "chatScope" = 'GROUP'));
