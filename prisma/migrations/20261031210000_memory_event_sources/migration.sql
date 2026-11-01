-- 忆泡的全部证据消息 id。
-- 之前只存第一条（sourceMessageId），一条忆泡由多句对话支撑时，后几句的来源就丢了。
ALTER TABLE "memory_events" ADD COLUMN "sourceMessageIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- 回填：旧行只有第一条，就把它当成唯一来源。
UPDATE "memory_events"
SET "sourceMessageIds" = ARRAY["sourceMessageId"]::TEXT[]
WHERE "sourceMessageId" IS NOT NULL;
