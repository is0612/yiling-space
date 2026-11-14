-- Keep private experience provenance separate from the global scope of an approved rule.
ALTER TABLE "character_expression_habits" DROP CONSTRAINT "character_expression_habits_source_check";
ALTER TABLE "character_expression_habits" ADD CONSTRAINT "character_expression_habits_source_check" CHECK (
  jsonb_typeof("sourceRefs") = 'array' AND (
    ("sourceType" = 'MANUAL' AND jsonb_array_length("sourceRefs") = 0 AND "conversationId" IS NULL AND "memoryScopeId" IS NULL)
    OR ("sourceType" = 'SOURCES' AND jsonb_array_length("sourceRefs") BETWEEN 1 AND 5 AND "conversationId" IS NULL AND "memoryScopeId" IS NULL)
    OR ("sourceType" = 'EXPERIENCE_REFLECT' AND jsonb_array_length("sourceRefs") BETWEEN 3 AND 30 AND "conversationId" IS NOT NULL AND "memoryScopeId" IS NOT NULL)
    OR ("sourceType" = 'EDUCATION_TRANSFER' AND jsonb_array_length("sourceRefs") BETWEEN 1 AND 30 AND "conversationId" IS NULL AND "memoryScopeId" IS NULL)
  )
);
