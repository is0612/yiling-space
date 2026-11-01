-- 忆泡：一次「发生了什么」的记录，事实层，只追加。
--
-- 和 memory_items 的分工：忆泡是事实（不覆盖、不替代），长期记忆是从事实里提炼的
-- 结论（可以被新条目替代、可以失效）。塞进 memory_items.content 会同时坏掉两件事：
-- 正文里的日期没法按区间查；后续周期总结还会把「第一次见面」这类事实改掉。
--
-- participants 目前存显示名的数组（渠道里的 member_1 这类代号也会进来），**不是身份引用**：
-- 跨平台身份必须经过验证绑定才能合并，别名表留到后续版本；查询侧只把它当关键词降级路径。
--
-- dedupeKey 由「范围 + 日期 + 归一化标题」生成，配合唯一约束保证周期任务重跑时
-- 不会把同一件事重复写两遍。

CREATE TYPE "MemoryEventStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

CREATE TABLE "memory_events" (
    "id" UUID NOT NULL,
    "memoryScopeId" UUID NOT NULL,
    "occurredAt" TIMESTAMPTZ(6) NOT NULL,
    "timeOfDay" VARCHAR(20),
    "precision" VARCHAR(20) NOT NULL DEFAULT 'day',
    "place" VARCHAR(200),
    "title" VARCHAR(200) NOT NULL,
    "detail" TEXT NOT NULL,
    "keywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "participants" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "confidence" DOUBLE PRECISION,
    "sourceMessageId" UUID,
    "sourceSnapshotId" UUID,
    "dedupeKey" VARCHAR(255) NOT NULL,
    "status" "MemoryEventStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_events_pkey" PRIMARY KEY ("id")
);

-- 同一范围里，同一件事只写一次。
CREATE UNIQUE INDEX "memory_events_memoryScopeId_dedupeKey_key"
    ON "memory_events"("memoryScopeId", "dedupeKey");

-- 时间轴：按天列举、按区间过滤都走它。
CREATE INDEX "memory_events_memoryScopeId_occurredAt_idx"
    ON "memory_events"("memoryScopeId", "occurredAt");

CREATE INDEX "memory_events_memoryScopeId_status_occurredAt_idx"
    ON "memory_events"("memoryScopeId", "status", "occurredAt");

ALTER TABLE "memory_events" ADD CONSTRAINT "memory_events_memoryScopeId_fkey"
    FOREIGN KEY ("memoryScopeId") REFERENCES "memory_scopes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 删消息只清「来源是哪条」，忆泡本身保留（和 memory_items 的口径一致）。
ALTER TABLE "memory_events" ADD CONSTRAINT "memory_events_sourceMessageId_fkey"
    FOREIGN KEY ("sourceMessageId") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "memory_events" ADD CONSTRAINT "memory_events_sourceSnapshotId_fkey"
    FOREIGN KEY ("sourceSnapshotId") REFERENCES "memory_snapshots"("id") ON DELETE SET NULL ON UPDATE CASCADE;
