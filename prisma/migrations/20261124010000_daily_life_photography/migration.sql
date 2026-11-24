-- Daily life plans, confirmed activities, and generated photo records.
CREATE TYPE "DailyLifePlanStatus" AS ENUM ('ACTIVE', 'ARCHIVED');
CREATE TYPE "DailyLifePlanItemStatus" AS ENUM ('PLANNED', 'COMPLETED', 'CANCELLED', 'SKIPPED', 'CHANGED');
CREATE TYPE "DailyLifeActivityStatus" AS ENUM ('IN_PROGRESS', 'COMPLETED');
CREATE TYPE "DailyLifeActivitySource" AS ENUM ('PLAN', 'USER_CONFIRMED', 'CHARACTER_INITIATED');
CREATE TYPE "DailyPhotoTrigger" AS ENUM ('USER_REQUESTED', 'CHARACTER_INITIATED', 'LIFE_CONTEXT', 'MEMORY_REVISIT');
CREATE TYPE "DailyPhotoStatus" AS ENUM ('GENERATED', 'GENERATION_FAILED', 'DELIVERY_PENDING', 'DELIVERED', 'DELIVERY_FAILED');

CREATE TABLE "daily_life_plans" (
  "id" UUID NOT NULL,
  "characterId" UUID NOT NULL,
  "dayKey" VARCHAR(10) NOT NULL,
  "timeZone" VARCHAR(80) NOT NULL DEFAULT 'Asia/Shanghai',
  "lifeType" VARCHAR(40) NOT NULL DEFAULT 'FREE',
  "status" "DailyLifePlanStatus" NOT NULL DEFAULT 'ACTIVE',
  "summary" VARCHAR(1000) NOT NULL DEFAULT '',
  "generatedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "daily_life_plans_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "daily_life_plans_characterId_dayKey_key" ON "daily_life_plans"("characterId", "dayKey");
CREATE INDEX "daily_life_plans_characterId_dayKey_status_idx" ON "daily_life_plans"("characterId", "dayKey", "status");
ALTER TABLE "daily_life_plans" ADD CONSTRAINT "daily_life_plans_characterId_fkey"
  FOREIGN KEY ("characterId") REFERENCES "characters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "daily_life_plan_items" (
  "id" UUID NOT NULL,
  "characterId" UUID NOT NULL,
  "planId" UUID NOT NULL,
  "title" VARCHAR(160) NOT NULL,
  "detail" TEXT NOT NULL DEFAULT '',
  "plannedStartAt" TIMESTAMPTZ(6),
  "plannedEndAt" TIMESTAMPTZ(6),
  "place" VARCHAR(200),
  "scene" VARCHAR(500) NOT NULL DEFAULT '',
  "outfitDescription" VARCHAR(1000) NOT NULL DEFAULT '',
  "propsDescription" VARCHAR(1000) NOT NULL DEFAULT '',
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "status" "DailyLifePlanItemStatus" NOT NULL DEFAULT 'PLANNED',
  "changeNote" VARCHAR(500) NOT NULL DEFAULT '',
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "daily_life_plan_items_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "daily_life_plan_items_characterId_plannedStartAt_idx" ON "daily_life_plan_items"("characterId", "plannedStartAt");
CREATE INDEX "daily_life_plan_items_planId_sortOrder_idx" ON "daily_life_plan_items"("planId", "sortOrder");
ALTER TABLE "daily_life_plan_items" ADD CONSTRAINT "daily_life_plan_items_characterId_fkey"
  FOREIGN KEY ("characterId") REFERENCES "characters"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "daily_life_plan_items" ADD CONSTRAINT "daily_life_plan_items_planId_fkey"
  FOREIGN KEY ("planId") REFERENCES "daily_life_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "daily_life_activities" (
  "id" UUID NOT NULL,
  "characterId" UUID NOT NULL,
  "planItemId" UUID,
  "title" VARCHAR(160) NOT NULL,
  "detail" TEXT NOT NULL DEFAULT '',
  "place" VARCHAR(200),
  "source" "DailyLifeActivitySource" NOT NULL,
  "sourceRef" VARCHAR(255),
  "status" "DailyLifeActivityStatus" NOT NULL DEFAULT 'IN_PROGRESS',
  "startedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "daily_life_activities_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "daily_life_activities_characterId_startedAt_idx" ON "daily_life_activities"("characterId", "startedAt");
CREATE INDEX "daily_life_activities_characterId_status_idx" ON "daily_life_activities"("characterId", "status");
CREATE INDEX "daily_life_activities_planItemId_idx" ON "daily_life_activities"("planItemId");
CREATE UNIQUE INDEX "daily_life_activities_one_active_per_character_key" ON "daily_life_activities"("characterId") WHERE "status" = 'IN_PROGRESS';
ALTER TABLE "daily_life_activities" ADD CONSTRAINT "daily_life_activities_characterId_fkey"
  FOREIGN KEY ("characterId") REFERENCES "characters"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "daily_life_activities" ADD CONSTRAINT "daily_life_activities_planItemId_fkey"
  FOREIGN KEY ("planItemId") REFERENCES "daily_life_plan_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "daily_photos" (
  "id" UUID NOT NULL,
  "characterId" UUID NOT NULL,
  "activityId" UUID,
  "trigger" "DailyPhotoTrigger" NOT NULL,
  "status" "DailyPhotoStatus" NOT NULL DEFAULT 'GENERATED',
  "prompt" TEXT NOT NULL,
  "provider" VARCHAR(40) NOT NULL,
  "model" VARCHAR(120) NOT NULL,
  "generationMode" VARCHAR(40) NOT NULL,
  "relativePath" VARCHAR(500),
  "mime" VARCHAR(80),
  "width" INTEGER,
  "height" INTEGER,
  "caption" VARCHAR(500) NOT NULL DEFAULT '',
  "generatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deliveredAt" TIMESTAMPTZ(6),
  "deliveryError" VARCHAR(500),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "daily_photos_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "daily_photos_characterId_generatedAt_idx" ON "daily_photos"("characterId", "generatedAt");
CREATE INDEX "daily_photos_activityId_generatedAt_idx" ON "daily_photos"("activityId", "generatedAt");
ALTER TABLE "daily_photos" ADD CONSTRAINT "daily_photos_characterId_fkey"
  FOREIGN KEY ("characterId") REFERENCES "characters"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "daily_photos" ADD CONSTRAINT "daily_photos_activityId_fkey"
  FOREIGN KEY ("activityId") REFERENCES "daily_life_activities"("id") ON DELETE SET NULL ON UPDATE CASCADE;
