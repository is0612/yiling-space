-- Nullable for old progress rows: replay their timestamp boundary once instead of skipping evidence.
ALTER TABLE "memory_event_days" ADD COLUMN "extractedMessageId" UUID;
