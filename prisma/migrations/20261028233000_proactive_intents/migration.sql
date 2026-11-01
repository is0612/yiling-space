-- CreateTable
CREATE TABLE "proactive_intents" (
    "id" UUID NOT NULL,
    "characterId" UUID NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "goal" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "urgency" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "origin" VARCHAR(20) NOT NULL,
    "dedupeKey" VARCHAR(255) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "sentAt" TIMESTAMPTZ(6),
    "content" TEXT,
    "recipient" VARCHAR(120),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "proactive_intents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "proactive_intents_characterId_status_createdAt_idx" ON "proactive_intents"("characterId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "proactive_intents_characterId_dedupeKey_key" ON "proactive_intents"("characterId", "dedupeKey");

-- AddForeignKey
ALTER TABLE "proactive_intents" ADD CONSTRAINT "proactive_intents_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "characters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

