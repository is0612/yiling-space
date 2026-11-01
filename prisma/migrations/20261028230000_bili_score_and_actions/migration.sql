-- AlterTable
ALTER TABLE "bili_seen_videos" ADD COLUMN     "score" INTEGER;

-- CreateTable
CREATE TABLE "bili_actions" (
    "id" UUID NOT NULL,
    "bindingId" UUID NOT NULL,
    "day" VARCHAR(10) NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "bvid" VARCHAR(32),
    "detail" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bili_actions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "bili_actions_bindingId_day_kind_idx" ON "bili_actions"("bindingId", "day", "kind");

-- CreateIndex
CREATE INDEX "bili_actions_bindingId_createdAt_idx" ON "bili_actions"("bindingId", "createdAt");

-- AddForeignKey
ALTER TABLE "bili_actions" ADD CONSTRAINT "bili_actions_bindingId_fkey" FOREIGN KEY ("bindingId") REFERENCES "character_channel_bindings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

