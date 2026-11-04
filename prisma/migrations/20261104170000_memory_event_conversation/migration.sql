-- 忆泡归属会话：群聊范围是 CHARACTER_GLOBAL，一个范围里挂着好几个群。
-- 只按范围检索时，「昨天在这个群跟谁聊」会把另一个群的 participants 也算进来
-- （实况：A 群的群友被报成了本群的人）。
--
-- 写入侧 `applyMemoryEvents` 早已按「最早一条证据所在的会话」收口，只是没存下来。
-- 这里补列 + 回填 + 索引；回填取第一条证据消息所在的会话，和写入侧同一口径。

ALTER TABLE "memory_events" ADD COLUMN "conversationId" UUID;

CREATE INDEX "memory_events_conversationId_occurredAt_idx"
    ON "memory_events"("conversationId", "occurredAt");

UPDATE "memory_events" e
SET "conversationId" = m."conversationId"
FROM "messages" m
WHERE e."conversationId" IS NULL
  AND e."sourceMessageIds"[1] = m."id"::text;

ALTER TABLE "memory_events"
    ADD CONSTRAINT "memory_events_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "conversations"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
