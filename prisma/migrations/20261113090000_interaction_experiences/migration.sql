CREATE TABLE "interaction_experiences" (
 "id" UUID NOT NULL, "characterId" UUID NOT NULL, "conversationId" UUID NOT NULL,
 "memoryScopeId" UUID NOT NULL, "assistantMessageId" UUID NOT NULL, "feedbackMessageId" UUID NOT NULL,
 "content" VARCHAR(400) NOT NULL, "context" VARCHAR(400) NOT NULL, "feedbackQuote" VARCHAR(400) NOT NULL,
 "evidenceHash" VARCHAR(64) NOT NULL,
 "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING', "revision" INTEGER NOT NULL DEFAULT 1,
 "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMPTZ(6) NOT NULL,
 CONSTRAINT "interaction_experiences_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "interaction_experiences_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "characters"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT "interaction_experiences_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT "interaction_experiences_status_check" CHECK ("status" IN ('PENDING','ACTIVE','REJECTED','DISABLED'))
);
CREATE UNIQUE INDEX "interaction_experiences_conversationId_assistantMessageId_fee_key" ON "interaction_experiences"("conversationId", "assistantMessageId", "feedbackMessageId");
CREATE INDEX "interaction_experiences_characterId_conversationId_memorySco_idx" ON "interaction_experiences"("characterId", "conversationId", "memoryScopeId", "status");
