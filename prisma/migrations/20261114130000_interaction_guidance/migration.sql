CREATE TABLE "character_interaction_guidance" (
 "id" UUID NOT NULL, "characterId" UUID NOT NULL,
 "kind" VARCHAR(20) NOT NULL, "content" VARCHAR(400) NOT NULL,
 "context" VARCHAR(400) NOT NULL DEFAULT '', "chatScope" VARCHAR(10) NOT NULL DEFAULT 'ALL',
 "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING', "revision" INTEGER NOT NULL DEFAULT 1,
 "sourceRefs" JSONB NOT NULL DEFAULT '[]', "reason" VARCHAR(1000) NOT NULL,
 "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMPTZ(6) NOT NULL,
 CONSTRAINT "character_interaction_guidance_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "interaction_guidance_kind_check" CHECK ("kind" IN ('UNDERSTANDING','REFERENCE','SITUATION','STRATEGY')),
 CONSTRAINT "interaction_guidance_scope_check" CHECK ("chatScope" IN ('ALL','GROUP','PRIVATE')),
 CONSTRAINT "interaction_guidance_status_check" CHECK ("status" IN ('PENDING','ACTIVE','DISABLED','REJECTED')),
 CONSTRAINT "interaction_guidance_revision_check" CHECK ("revision">0),
 CONSTRAINT "interaction_guidance_sources_check" CHECK (jsonb_typeof("sourceRefs")='array' AND jsonb_array_length("sourceRefs") BETWEEN 1 AND 30),
 CONSTRAINT "character_interaction_guidance_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "characters"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "character_interaction_guidance_characterId_status_updatedAt_idx" ON "character_interaction_guidance"("characterId","status","updatedAt");
CREATE TABLE "character_interaction_guidance_revisions" (
 "id" UUID NOT NULL, "guidanceId" UUID NOT NULL, "revision" INTEGER NOT NULL,
 "action" VARCHAR(20) NOT NULL, "kind" VARCHAR(20) NOT NULL, "content" VARCHAR(400) NOT NULL,
 "context" VARCHAR(400) NOT NULL, "chatScope" VARCHAR(10) NOT NULL,
 "status" VARCHAR(20) NOT NULL, "sourceRefs" JSONB NOT NULL, "reason" VARCHAR(1000) NOT NULL,
 "actorId" UUID NOT NULL, "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "character_interaction_guidance_revisions_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "interaction_guidance_revision_kind_check" CHECK ("kind" IN ('UNDERSTANDING','REFERENCE','SITUATION','STRATEGY')),
 CONSTRAINT "interaction_guidance_revision_scope_check" CHECK ("chatScope" IN ('ALL','GROUP','PRIVATE')),
 CONSTRAINT "interaction_guidance_revision_status_check" CHECK ("status" IN ('PENDING','ACTIVE','DISABLED','REJECTED')),
 CONSTRAINT "interaction_guidance_revision_action_check" CHECK ("action" IN ('CREATE','EDIT','ACTIVATE','REJECT','DISABLE')),
 CONSTRAINT "interaction_guidance_revision_number_check" CHECK ("revision">0),
 CONSTRAINT "character_interaction_guidance_revisions_guidanceId_fkey" FOREIGN KEY ("guidanceId") REFERENCES "character_interaction_guidance"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "character_interaction_guidance_revisions_guidanceId_revision_key" ON "character_interaction_guidance_revisions"("guidanceId","revision");
