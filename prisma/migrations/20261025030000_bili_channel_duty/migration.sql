-- CreateTable
CREATE TABLE "bili_round_reports" (
    "id" UUID NOT NULL,
    "bindingId" UUID NOT NULL,
    "day" VARCHAR(10) NOT NULL,
    "roundIndex" INTEGER NOT NULL DEFAULT 1,
    "pickedCount" INTEGER NOT NULL DEFAULT 0,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bili_round_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bili_seen_videos" (
    "id" UUID NOT NULL,
    "bindingId" UUID NOT NULL,
    "bvid" VARCHAR(32) NOT NULL,
    "title" VARCHAR(255),
    "author" VARCHAR(120),
    "result" VARCHAR(20) NOT NULL,
    "reason" TEXT,
    "seenAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bili_seen_videos_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "bili_round_reports_bindingId_day_roundIndex_key" ON "bili_round_reports"("bindingId", "day", "roundIndex");

-- CreateIndex
CREATE INDEX "bili_round_reports_bindingId_createdAt_idx" ON "bili_round_reports"("bindingId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "bili_seen_videos_bindingId_bvid_key" ON "bili_seen_videos"("bindingId", "bvid");

-- CreateIndex
CREATE INDEX "bili_seen_videos_bindingId_seenAt_idx" ON "bili_seen_videos"("bindingId", "seenAt");

-- AddForeignKey
ALTER TABLE "bili_round_reports" ADD CONSTRAINT "bili_round_reports_bindingId_fkey" FOREIGN KEY ("bindingId") REFERENCES "character_channel_bindings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bili_seen_videos" ADD CONSTRAINT "bili_seen_videos_bindingId_fkey" FOREIGN KEY ("bindingId") REFERENCES "character_channel_bindings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
