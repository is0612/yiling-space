CREATE TABLE "channel_behavior_policies" (
 "id" UUID PRIMARY KEY, "characterId" UUID NOT NULL REFERENCES "characters"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "kind" VARCHAR(32) NOT NULL CHECK ("kind"='GROUP_AT_DISABLED'), "content" VARCHAR(200) NOT NULL CHECK ("content"='被动群聊回复不发送 @ 提醒，引用仍保留。'),
 "chatScope" VARCHAR(10) NOT NULL DEFAULT 'GROUP' CHECK ("chatScope"='GROUP'),
 "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK ("status" IN ('PENDING','ACTIVE','DISABLED','REJECTED')),
 "revision" INTEGER NOT NULL DEFAULT 1 CHECK ("revision">0), "sourceRefs" JSONB NOT NULL CHECK (jsonb_typeof("sourceRefs")='array' AND jsonb_array_length("sourceRefs") BETWEEN 1 AND 30),
 "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMPTZ(6) NOT NULL
);
CREATE INDEX "channel_behavior_policies_characterId_status_idx" ON "channel_behavior_policies"("characterId","status");
CREATE TABLE "channel_behavior_policy_revisions" (
 "id" UUID PRIMARY KEY, "policyId" UUID NOT NULL REFERENCES "channel_behavior_policies"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "revision" INTEGER NOT NULL CHECK ("revision">0), "action" VARCHAR(20) NOT NULL CHECK ("action" IN ('CREATE','ACTIVATE','DISABLE','REJECT')),
 "kind" VARCHAR(32) NOT NULL CHECK ("kind"='GROUP_AT_DISABLED'), "content" VARCHAR(200) NOT NULL CHECK ("content"='被动群聊回复不发送 @ 提醒，引用仍保留。'),
 "chatScope" VARCHAR(10) NOT NULL CHECK ("chatScope"='GROUP'), "status" VARCHAR(20) NOT NULL CHECK ("status" IN ('PENDING','ACTIVE','DISABLED','REJECTED')),
 "sourceRefs" JSONB NOT NULL, "actorId" UUID NOT NULL, "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE ("policyId","revision")
);
