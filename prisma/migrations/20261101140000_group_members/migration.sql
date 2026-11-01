-- 谁在哪个群里说过话。
--
-- 熟客榜要按群分开（「这个群里跟我熟的是谁」）。不建这张表也能查 —— 消息的
-- `metadata->>'authorOpenId'` 里有 QQ 号 —— 但那要按发言人聚合整段会话的 JSON，
-- 加不了索引，聊得越久越慢。关系范围（MemoryScope）只记「某角色 × 某人」，
-- 不记在哪认识的。所以单独一张小表，写入时机就是群聊落库那一轮。

CREATE TABLE "group_members" (
    "id" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "characterId" UUID NOT NULL,
    "platformUid" VARCHAR(255) NOT NULL,
    "displayName" VARCHAR(255),
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "firstSpokeAt" TIMESTAMPTZ(6) NOT NULL,
    "lastSpokeAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "group_members_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "group_members_conversationId_platformUid_key" ON "group_members"("conversationId", "platformUid");
CREATE INDEX "group_members_conversationId_messageCount_idx" ON "group_members"("conversationId", "messageCount");
CREATE INDEX "group_members_characterId_platformUid_idx" ON "group_members"("characterId", "platformUid");

ALTER TABLE "group_members"
    ADD CONSTRAINT "group_members_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "conversations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- 回填：从已有的群聊消息里把发言人聚出来。不补的话，本群熟客榜要等群里下次开口才有内容。
INSERT INTO "group_members" (
    "id", "conversationId", "characterId", "platformUid", "displayName",
    "messageCount", "firstSpokeAt", "lastSpokeAt", "createdAt", "updatedAt"
)
SELECT
    gen_random_uuid(),
    m."conversationId",
    c."characterId",
    m."metadata"->>'authorOpenId',
    (array_agg(m."metadata"->>'authorDisplayName' ORDER BY m."occurredAt" DESC))[1],
    COUNT(*),
    MIN(m."occurredAt"),
    MAX(m."occurredAt"),
    NOW(),
    NOW()
FROM "messages" m
JOIN "conversations" c ON c."id" = m."conversationId"
WHERE m."role"::text = 'USER'
  AND m."metadata"->>'source' = 'channel'
  AND c."externalConversationId" LIKE 'g:%'
  AND COALESCE(m."metadata"->>'authorOpenId', '') <> ''
GROUP BY m."conversationId", c."characterId", m."metadata"->>'authorOpenId'
ON CONFLICT ("conversationId", "platformUid") DO NOTHING;
