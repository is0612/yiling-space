CREATE TABLE "interaction_experience_progress" (
 "conversationId" UUID PRIMARY KEY REFERENCES "conversations"("id") ON DELETE CASCADE,
 "anchorAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "cursorAt" TIMESTAMPTZ(6), "cursorId" UUID,
 "status" VARCHAR(20) NOT NULL DEFAULT 'QUEUED', "token" UUID, "leaseUntil" TIMESTAMPTZ(6),
 "runAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "attempts" INTEGER NOT NULL DEFAULT 0,
 "lastError" VARCHAR(80), "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "interaction_experience_activation" ("id" INTEGER PRIMARY KEY, "anchorAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP);
INSERT INTO "interaction_experience_activation" ("id") VALUES (1);
