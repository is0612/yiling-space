ALTER TABLE "character_memory_settings"
ADD COLUMN IF NOT EXISTS "rawMessageCleanupEnabled" BOOLEAN NOT NULL DEFAULT false;
