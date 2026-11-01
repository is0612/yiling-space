ALTER TYPE "MemoryItemStatus" ADD VALUE 'TRASHED';

ALTER TABLE "memory_items"
  ADD COLUMN "statusBeforeTrash" "MemoryItemStatus",
  ADD COLUMN "deletedAt" TIMESTAMPTZ(6);

CREATE INDEX "memory_items_memoryScopeId_status_deletedAt_idx"
  ON "memory_items"("memoryScopeId", "status", "deletedAt");
