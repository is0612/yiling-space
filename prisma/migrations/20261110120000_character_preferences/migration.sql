CREATE TABLE "character_preferences" (
  "id" UUID NOT NULL,
  "characterId" UUID NOT NULL,
  "kind" VARCHAR(20) NOT NULL,
  "topic" VARCHAR(100) NOT NULL,
  "reason" VARCHAR(1000) NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  "revision" INTEGER NOT NULL DEFAULT 1,
  "sourceType" VARCHAR(20) NOT NULL DEFAULT 'MANUAL',
  "sourceRefs" JSONB NOT NULL DEFAULT '[]',
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "character_preferences_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "character_preferences_kind_check" CHECK ("kind" IN ('LIKE','DISLIKE','INTEREST')),
  CONSTRAINT "character_preferences_status_check" CHECK ("status" IN ('PENDING','ACTIVE','REJECTED','DISABLED')),
  CONSTRAINT "character_preferences_source_check" CHECK ("sourceType" IN ('MANUAL','SOURCES') AND jsonb_typeof("sourceRefs") = 'array' AND (("sourceType" = 'MANUAL' AND jsonb_array_length("sourceRefs") = 0) OR ("sourceType" = 'SOURCES' AND jsonb_array_length("sourceRefs") BETWEEN 1 AND 5))),
  CONSTRAINT "character_preferences_content_check" CHECK (length(btrim("topic")) > 0 AND length(btrim("reason")) > 0 AND "revision" > 0)
);
CREATE TABLE "character_preference_revisions" (
  "id" UUID NOT NULL,
  "preferenceId" UUID NOT NULL,
  "revision" INTEGER NOT NULL,
  "action" VARCHAR(20) NOT NULL,
  "kind" VARCHAR(20) NOT NULL,
  "topic" VARCHAR(100) NOT NULL,
  "reason" VARCHAR(1000) NOT NULL,
  "status" VARCHAR(20) NOT NULL,
  "sourceType" VARCHAR(20) NOT NULL,
  "sourceRefs" JSONB NOT NULL,
  "actorId" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "character_preference_revisions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "character_preference_revisions_action_check" CHECK ("action" IN ('CREATE','EDIT','ACTIVATE','REJECT','DISABLE')),
  CONSTRAINT "character_preference_revisions_kind_check" CHECK ("kind" IN ('LIKE','DISLIKE','INTEREST')),
  CONSTRAINT "character_preference_revisions_status_check" CHECK ("status" IN ('PENDING','ACTIVE','REJECTED','DISABLED')),
  CONSTRAINT "character_preference_revisions_revision_check" CHECK ("revision" > 0)
);
CREATE INDEX "character_preferences_characterId_status_updatedAt_idx" ON "character_preferences"("characterId", "status", "updatedAt");
CREATE UNIQUE INDEX "character_preference_revisions_preferenceId_revision_key" ON "character_preference_revisions"("preferenceId", "revision");
ALTER TABLE "character_preferences" ADD CONSTRAINT "character_preferences_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "characters"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "character_preference_revisions" ADD CONSTRAINT "character_preference_revisions_preferenceId_fkey" FOREIGN KEY ("preferenceId") REFERENCES "character_preferences"("id") ON DELETE CASCADE ON UPDATE CASCADE;
