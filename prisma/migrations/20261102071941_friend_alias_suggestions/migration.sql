-- CreateTable
CREATE TABLE "friend_alias_suggestions" (
    "id" UUID NOT NULL,
    "scopeId" UUID NOT NULL,
    "alias" VARCHAR(40) NOT NULL,
    "reason" VARCHAR(200) NOT NULL DEFAULT '',
    "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "aliasKey" VARCHAR(80) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "friend_alias_suggestions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "friend_alias_suggestions_status_createdAt_idx" ON "friend_alias_suggestions"("status", "createdAt");

-- CreateIndex
CREATE INDEX "friend_alias_suggestions_scopeId_status_idx" ON "friend_alias_suggestions"("scopeId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "friend_alias_suggestions_scopeId_aliasKey_key" ON "friend_alias_suggestions"("scopeId", "aliasKey");

-- AddForeignKey
ALTER TABLE "friend_alias_suggestions" ADD CONSTRAINT "friend_alias_suggestions_scopeId_fkey" FOREIGN KEY ("scopeId") REFERENCES "memory_scopes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
