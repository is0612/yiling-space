CREATE TABLE "group_observation_progress" (
  "conversationId" UUID PRIMARY KEY,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "anchorAt" TIMESTAMPTZ(6) NOT NULL,
  "cursorIngestKey" VARCHAR(40),
  "cursorId" UUID,
  "runAt" TIMESTAMPTZ(6) NOT NULL,
  "leaseToken" UUID,
  "leaseUntil" TIMESTAMPTZ(6),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastError" VARCHAR(40),
  CONSTRAINT "group_observation_progress_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "group_observation_progress_enabled_runAt_idx" ON "group_observation_progress"("enabled", "runAt");
CREATE INDEX "messages_observation_ingest_idx" ON "messages"("conversationId", "ingestedAt", "id");
