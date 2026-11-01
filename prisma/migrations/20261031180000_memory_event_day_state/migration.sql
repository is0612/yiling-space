-- 忆泡「还在长」的状态。
--
-- 之前一张表只记录已经收口的一天：昨天的对话要等夜间任务才有忆泡，今天问「今天做了什么」
-- 只能靠最近 40 条对话。现在给每一天加一个进度行（memory_event_days）：
--   DRAFT = 当天还在累积，白天按增量抽取；
--   FINAL = 昨天已收口，不再追加。
-- 忆泡本身也带上 dayKey/state，查询时两者都算数，只是写入语义不同。
--
-- 历史数据：旧行来自 8 天周期，早已收口，统一标成 FINAL；dayKey 按默认时区回填。

CREATE TYPE "MemoryEventState" AS ENUM ('DRAFT', 'FINAL');

ALTER TABLE "memory_events" ADD COLUMN "dayKey" VARCHAR(10);
ALTER TABLE "memory_events" ADD COLUMN "state" "MemoryEventState" NOT NULL DEFAULT 'DRAFT';

UPDATE "memory_events"
SET "dayKey" = to_char(("occurredAt" AT TIME ZONE 'Asia/Shanghai')::date, 'YYYY-MM-DD')
WHERE "dayKey" IS NULL;

UPDATE "memory_events" SET "state" = 'FINAL';

ALTER TABLE "memory_events" ALTER COLUMN "dayKey" SET NOT NULL;

CREATE INDEX "memory_events_memoryScopeId_dayKey_idx"
    ON "memory_events"("memoryScopeId", "dayKey");

CREATE TABLE "memory_event_days" (
    "id" UUID NOT NULL,
    "memoryScopeId" UUID NOT NULL,
    "dayKey" VARCHAR(10) NOT NULL,
    "state" "MemoryEventState" NOT NULL DEFAULT 'DRAFT',
    "eventCount" INTEGER NOT NULL DEFAULT 0,
    "extractedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "memory_event_days_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "memory_event_days_memoryScopeId_dayKey_key"
    ON "memory_event_days"("memoryScopeId", "dayKey");

CREATE INDEX "memory_event_days_memoryScopeId_state_idx"
    ON "memory_event_days"("memoryScopeId", "state");

ALTER TABLE "memory_event_days" ADD CONSTRAINT "memory_event_days_memoryScopeId_fkey"
    FOREIGN KEY ("memoryScopeId") REFERENCES "memory_scopes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
