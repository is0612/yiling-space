CREATE TABLE "character_goals" (
  "id" UUID NOT NULL, "characterId" UUID NOT NULL, "kind" VARCHAR(20) NOT NULL,
  "title" VARCHAR(100) NOT NULL, "description" VARCHAR(1000) NOT NULL, "reason" VARCHAR(1000) NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING', "revision" INTEGER NOT NULL DEFAULT 1,
  "sourceType" VARCHAR(20) NOT NULL DEFAULT 'MANUAL', "sourceRefs" JSONB NOT NULL DEFAULT '[]',
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "character_goals_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "character_goals_kind_check" CHECK ("kind" IN ('GOAL','WISH')),
  CONSTRAINT "character_goals_status_check" CHECK ("status" IN ('PENDING','ACTIVE','PAUSED','COMPLETED','ABANDONED','REJECTED')),
  CONSTRAINT "character_goals_content_check" CHECK (length(btrim("title"))>0 AND length(btrim("description"))>0 AND length(btrim("reason"))>0 AND "revision">0),
  CONSTRAINT "character_goals_source_check" CHECK ("sourceType" IN ('MANUAL','SOURCES') AND jsonb_typeof("sourceRefs")='array' AND (("sourceType"='MANUAL' AND jsonb_array_length("sourceRefs")=0) OR ("sourceType"='SOURCES' AND jsonb_array_length("sourceRefs") BETWEEN 1 AND 5)))
);
CREATE TABLE "character_goal_revisions" (
  "id" UUID NOT NULL, "goalId" UUID NOT NULL, "revision" INTEGER NOT NULL, "action" VARCHAR(20) NOT NULL,
  "kind" VARCHAR(20) NOT NULL, "title" VARCHAR(100) NOT NULL, "description" VARCHAR(1000) NOT NULL, "reason" VARCHAR(1000) NOT NULL,
  "status" VARCHAR(20) NOT NULL, "sourceType" VARCHAR(20) NOT NULL, "sourceRefs" JSONB NOT NULL,
  "actorId" UUID NOT NULL, "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "character_goal_revisions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "character_goal_revisions_revision_check" CHECK ("revision">0),
  CONSTRAINT "character_goal_revisions_kind_check" CHECK ("kind" IN ('GOAL','WISH')),
  CONSTRAINT "character_goal_revisions_status_check" CHECK ("status" IN ('PENDING','ACTIVE','PAUSED','COMPLETED','ABANDONED','REJECTED')),
  CONSTRAINT "character_goal_revisions_action_check" CHECK ("action" IN ('CREATE','EDIT','ACTIVATE','PAUSE','COMPLETE','ABANDON','REJECT','PROGRESS'))
);
CREATE TABLE "character_goal_progress" (
  "id" UUID NOT NULL, "goalId" UUID NOT NULL, "requestKey" UUID NOT NULL, "payloadHash" VARCHAR(64) NOT NULL,
  "content" VARCHAR(1000) NOT NULL, "sourceRefs" JSONB NOT NULL DEFAULT '[]',
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "character_goal_progress_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "character_goal_progress_content_check" CHECK (length(btrim("content"))>0 AND "payloadHash" ~ '^[a-f0-9]{64}$' AND jsonb_typeof("sourceRefs")='array' AND jsonb_array_length("sourceRefs")<=5)
);
CREATE INDEX "character_goals_characterId_status_updatedAt_idx" ON "character_goals"("characterId","status","updatedAt");
CREATE UNIQUE INDEX "character_goal_revisions_goalId_revision_key" ON "character_goal_revisions"("goalId","revision");
CREATE UNIQUE INDEX "character_goal_progress_goalId_requestKey_key" ON "character_goal_progress"("goalId","requestKey");
CREATE INDEX "character_goal_progress_goalId_createdAt_idx" ON "character_goal_progress"("goalId","createdAt");
ALTER TABLE "character_goals" ADD CONSTRAINT "character_goals_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "characters"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "character_goal_revisions" ADD CONSTRAINT "character_goal_revisions_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "character_goals"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "character_goal_progress" ADD CONSTRAINT "character_goal_progress_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "character_goals"("id") ON DELETE CASCADE ON UPDATE CASCADE;
