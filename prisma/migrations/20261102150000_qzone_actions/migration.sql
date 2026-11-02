-- QQ 空间动作（发说说 / 评论）的草稿与发布记录。
--
-- 为什么不复用 `onebot_group_announcements`：那张表的 groupId 是 NOT NULL，而空间动作
-- 根本不发生在群里（私聊也能触发）；而且限流要按「今天发了几条说说」统计，混着公告
-- 一起数会数错。所以单独一张表，kind 区分 POST / COMMENT。

CREATE TABLE "onebot_qzone_actions" (
    "id" UUID NOT NULL,
    "connectionId" UUID NOT NULL,
    "characterId" UUID,
    "kind" VARCHAR(16) NOT NULL,
    "content" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "targetUin" VARCHAR(64),
    "targetTid" VARCHAR(128),
    "targetExcerpt" TEXT,
    "visible" INTEGER NOT NULL DEFAULT 1,
    "requestedBy" VARCHAR(64) NOT NULL,
    "conversationKey" VARCHAR(128),
    "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "resultTid" VARCHAR(128),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "publishedAt" TIMESTAMPTZ(6),

    CONSTRAINT "onebot_qzone_actions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "onebot_qzone_actions_connection_status_idx"
    ON "onebot_qzone_actions"("connectionId", "status", "createdAt");
CREATE INDEX "onebot_qzone_actions_connection_kind_published_idx"
    ON "onebot_qzone_actions"("connectionId", "kind", "publishedAt");
