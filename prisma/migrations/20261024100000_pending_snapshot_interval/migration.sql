ALTER TABLE "character_memory_settings"
ADD COLUMN IF NOT EXISTS "pendingSnapshotIntervalDays" INTEGER;
