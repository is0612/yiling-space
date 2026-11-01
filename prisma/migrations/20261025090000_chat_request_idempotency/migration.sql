CREATE TABLE "chat_requests" (
  "id" UUID NOT NULL,
  "ownerId" UUID NOT NULL,
  "characterId" UUID NOT NULL,
  "requestKey" UUID NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'PROCESSING',
  "conversationId" UUID,
  "response" JSONB,
  "lastError" VARCHAR(700),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "chat_requests_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "chat_requests_ownerId_characterId_requestKey_key"
  ON "chat_requests"("ownerId", "characterId", "requestKey");

CREATE INDEX "chat_requests_status_updatedAt_idx"
  ON "chat_requests"("status", "updatedAt");
