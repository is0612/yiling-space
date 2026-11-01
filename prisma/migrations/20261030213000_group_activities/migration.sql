-- QQ 群「安静了多久」的落库记录：主动找话题要靠它判断冷场。
--
-- 为什么不能靠 conversations.lastMessageAt：群消息平时不落库，
-- 她没回话的那一轮连会话行都不会更新，只看它会得到「一直很安静」的错觉
-- —— 群里明明正热闹，她却被判成冷场然后插一句，正是最糟的时机。
--
-- lastAttemptAt 与 lastInitiativeAt 分开：前者含「模型判定不说」的尝试，
-- 闸门的最短间隔看它（否则死群每分钟调一次模型）；后者只记真的开口，给页面看。

CREATE TABLE "group_activities" (
    "id" UUID NOT NULL,
    "channelBindingId" UUID NOT NULL,
    "characterId" UUID NOT NULL,
    "externalConversationId" VARCHAR(255) NOT NULL,
    "groupId" VARCHAR(64) NOT NULL,
    "lastMessageAt" TIMESTAMPTZ(6) NOT NULL,
    "lastSpokeAt" TIMESTAMPTZ(6),
    "lastInitiativeAt" TIMESTAMPTZ(6),
    "lastAttemptAt" TIMESTAMPTZ(6),
    "recentLines" JSONB,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "group_activities_pkey" PRIMARY KEY ("id")
);

-- 一条绑定可以挂多个群，所以唯一键必须带上会话 key。
CREATE UNIQUE INDEX "group_activities_channelBindingId_externalConversationId_key"
    ON "group_activities"("channelBindingId", "externalConversationId");

CREATE INDEX "group_activities_characterId_lastMessageAt_idx"
    ON "group_activities"("characterId", "lastMessageAt");
