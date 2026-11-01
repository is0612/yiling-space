-- QQ 群公告草稿：管理员拟稿后需在有效期内确认发布，确认动作不可重复执行。
CREATE TABLE "onebot_group_announcements" (
    "id" UUID NOT NULL,
    "connectionId" UUID NOT NULL,
    "groupId" VARCHAR(64) NOT NULL,
    "requestedBy" VARCHAR(64) NOT NULL,
    "characterId" UUID,
    "topic" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "publishedAt" TIMESTAMPTZ(6),

    CONSTRAINT "onebot_group_announcements_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "onebot_group_announcements_connection_group_status_idx"
    ON "onebot_group_announcements"("connectionId", "groupId", "status", "createdAt");
