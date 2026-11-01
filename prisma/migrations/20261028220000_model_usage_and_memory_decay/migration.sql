-- AlterTable
ALTER TABLE "memory_items" ADD COLUMN     "importance" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
ADD COLUMN     "lastRecalledAt" TIMESTAMPTZ(6),
ADD COLUMN     "recallCount" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "model_usages" (
    "id" UUID NOT NULL,
    "kind" VARCHAR(40) NOT NULL,
    "model" VARCHAR(120) NOT NULL,
    "characterId" UUID,
    "userId" UUID,
    "conversationId" UUID,
    "channelBindingId" UUID,
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "reasoningTokens" INTEGER,
    "metadata" JSONB,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "model_usages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "model_usages_characterId_createdAt_idx" ON "model_usages"("characterId", "createdAt");

-- CreateIndex
CREATE INDEX "model_usages_kind_createdAt_idx" ON "model_usages"("kind", "createdAt");

-- CreateIndex
CREATE INDEX "model_usages_createdAt_idx" ON "model_usages"("createdAt");

