CREATE TABLE "roleplay_settings" (
 "ownerId" UUID NOT NULL PRIMARY KEY,"apiBaseUrl" TEXT NOT NULL DEFAULT 'https://api.deepseek.com',"model" TEXT NOT NULL DEFAULT 'deepseek-flash',"apiKeyCiphertext" TEXT,"thinking" BOOLEAN NOT NULL DEFAULT false,"temperature" DOUBLE PRECISION NOT NULL DEFAULT 0.8,"maxTokens" INTEGER NOT NULL DEFAULT 4096,"contextWindowTokens" INTEGER NOT NULL DEFAULT 65536,"contextBudgetTokens" INTEGER NOT NULL DEFAULT 24000,"recentMessageLimit" INTEGER NOT NULL DEFAULT 40,"updatedAt" TIMESTAMPTZ(6) NOT NULL
);
CREATE TABLE "roleplay_personas" (
 "id" UUID NOT NULL PRIMARY KEY,"ownerId" UUID NOT NULL,"name" VARCHAR(100) NOT NULL,"prompt" TEXT NOT NULL,"opening" TEXT NOT NULL DEFAULT '',"createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" TIMESTAMPTZ(6) NOT NULL
);
CREATE INDEX "roleplay_personas_ownerId_updatedAt_idx" ON "roleplay_personas"("ownerId","updatedAt");
CREATE TABLE "roleplay_sessions" (
 "id" UUID NOT NULL PRIMARY KEY,"ownerId" UUID NOT NULL,"personaId" UUID,"hostCharacterId" UUID,"title" VARCHAR(200) NOT NULL,"personaSnapshot" JSONB NOT NULL,"summary" TEXT NOT NULL DEFAULT '',"summaryThrough" INTEGER NOT NULL DEFAULT 0,"messageCount" INTEGER NOT NULL DEFAULT 0,"leaseToken" UUID,"leaseUntil" TIMESTAMPTZ(6),"createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" TIMESTAMPTZ(6) NOT NULL,
 CONSTRAINT "roleplay_sessions_personaId_fkey" FOREIGN KEY("personaId") REFERENCES "roleplay_personas"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "roleplay_sessions_ownerId_updatedAt_idx" ON "roleplay_sessions"("ownerId","updatedAt");
CREATE TABLE "roleplay_messages" (
 "id" UUID NOT NULL PRIMARY KEY,"sessionId" UUID NOT NULL,"sequence" INTEGER NOT NULL,"role" VARCHAR(12) NOT NULL,"content" TEXT NOT NULL,"requestId" VARCHAR(100),"source" VARCHAR(30) NOT NULL DEFAULT 'web',"createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "roleplay_messages_sessionId_fkey" FOREIGN KEY("sessionId") REFERENCES "roleplay_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "roleplay_messages_sessionId_sequence_key" ON "roleplay_messages"("sessionId","sequence");
CREATE UNIQUE INDEX "roleplay_messages_sessionId_requestId_role_key" ON "roleplay_messages"("sessionId","requestId","role");
CREATE TABLE "roleplay_routes" (
 "id" UUID NOT NULL PRIMARY KEY,"ownerId" UUID NOT NULL,"bindingId" UUID NOT NULL,"externalConversationId" VARCHAR(255) NOT NULL,"userId" UUID NOT NULL,"characterId" UUID NOT NULL,"sessionId" UUID NOT NULL,"createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" TIMESTAMPTZ(6) NOT NULL,
 CONSTRAINT "roleplay_routes_sessionId_fkey" FOREIGN KEY("sessionId") REFERENCES "roleplay_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "roleplay_routes_bindingId_externalConversationId_key" ON "roleplay_routes"("bindingId","externalConversationId");
CREATE INDEX "roleplay_routes_ownerId_idx" ON "roleplay_routes"("ownerId");
CREATE TABLE "roleplay_channel_receipts" (
 "id" UUID NOT NULL PRIMARY KEY,"ownerId" UUID NOT NULL,"bindingId" UUID NOT NULL,"externalMessageId" VARCHAR(255) NOT NULL,"reply" TEXT NOT NULL,"createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "roleplay_channel_receipts_bindingId_externalMessageId_key" ON "roleplay_channel_receipts"("bindingId","externalMessageId");
CREATE INDEX "roleplay_channel_receipts_ownerId_createdAt_idx" ON "roleplay_channel_receipts"("ownerId","createdAt");
