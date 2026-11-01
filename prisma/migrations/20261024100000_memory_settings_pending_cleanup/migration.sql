-- Backward-compatible settings migration. The dedicated migrations before/after this
-- file may have already added these columns, so keep this step idempotent.
ALTER TABLE "character_memory_settings"
  ADD COLUMN IF NOT EXISTS "pendingSnapshotIntervalDays" INTEGER,
  ADD COLUMN IF NOT EXISTS "rawMessageCleanupEnabled" BOOLEAN NOT NULL DEFAULT false;
