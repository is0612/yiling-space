CREATE TABLE "character_expression_habits" (
  "id" UUID NOT NULL,
  "characterId" UUID NOT NULL,
  "kind" VARCHAR(20) NOT NULL,
  "content" VARCHAR(300) NOT NULL,
  "context" VARCHAR(200) NOT NULL DEFAULT '',
  "reason" VARCHAR(1000) NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  "revision" INTEGER NOT NULL DEFAULT 1,
  "sourceType" VARCHAR(20) NOT NULL DEFAULT 'MANUAL',
  "sourceRefs" JSONB NOT NULL DEFAULT '[]',
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "character_expression_habits_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "character_expression_habits_kind_check" CHECK ("kind" IN ('TONE','WORDING','LENGTH')),
  CONSTRAINT "character_expression_habits_status_check" CHECK ("status" IN ('PENDING','ACTIVE','REJECTED','DISABLED')),
  CONSTRAINT "character_expression_habits_source_check" CHECK ("sourceType" IN ('MANUAL','SOURCES') AND jsonb_typeof("sourceRefs") = 'array' AND (("sourceType" = 'MANUAL' AND jsonb_array_length("sourceRefs") = 0) OR ("sourceType" = 'SOURCES' AND jsonb_array_length("sourceRefs") BETWEEN 1 AND 5))),
  CONSTRAINT "character_expression_habits_content_check" CHECK (length(btrim("content")) > 0 AND length(btrim("reason")) > 0 AND "revision" > 0)
);
CREATE TABLE "character_expression_habit_revisions" (
  "id" UUID NOT NULL,
  "habitId" UUID NOT NULL,
  "revision" INTEGER NOT NULL,
  "action" VARCHAR(20) NOT NULL,
  "kind" VARCHAR(20) NOT NULL,
  "content" VARCHAR(300) NOT NULL,
  "context" VARCHAR(200) NOT NULL,
  "reason" VARCHAR(1000) NOT NULL,
  "status" VARCHAR(20) NOT NULL,
  "sourceType" VARCHAR(20) NOT NULL,
  "sourceRefs" JSONB NOT NULL,
  "actorId" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "character_expression_habit_revisions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "character_expression_habit_revisions_action_check" CHECK ("action" IN ('CREATE','EDIT','ACTIVATE','REJECT','DISABLE')),
  CONSTRAINT "character_expression_habit_revisions_kind_check" CHECK ("kind" IN ('TONE','WORDING','LENGTH')),
  CONSTRAINT "character_expression_habit_revisions_status_check" CHECK ("status" IN ('PENDING','ACTIVE','REJECTED','DISABLED')),
  CONSTRAINT "character_expression_habit_revisions_revision_check" CHECK ("revision" > 0)
);
CREATE INDEX "character_expression_habits_characterId_status_updatedAt_idx" ON "character_expression_habits"("characterId", "status", "updatedAt");
CREATE UNIQUE INDEX "character_expression_habit_revisions_habitId_revision_key" ON "character_expression_habit_revisions"("habitId", "revision");
ALTER TABLE "character_expression_habits" ADD CONSTRAINT "character_expression_habits_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "characters"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "character_expression_habit_revisions" ADD CONSTRAINT "character_expression_habit_revisions_habitId_fkey" FOREIGN KEY ("habitId") REFERENCES "character_expression_habits"("id") ON DELETE CASCADE ON UPDATE CASCADE;
