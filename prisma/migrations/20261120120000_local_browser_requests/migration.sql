-- 管理员审批后才执行的独立浏览器操作记录。
CREATE TABLE "local_browser_requests" (
  "id" UUID NOT NULL,
  "actorId" UUID NOT NULL,
  "characterId" UUID,
  "conversationId" UUID,
  "taskId" UUID,
  "url" VARCHAR(2048) NOT NULL,
  "actions" JSONB NOT NULL DEFAULT '[]',
  "reason" VARCHAR(500) NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  "result" JSONB,
  "error" VARCHAR(500),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decidedAt" TIMESTAMPTZ(6),
  "finishedAt" TIMESTAMPTZ(6),
  CONSTRAINT "local_browser_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "local_browser_requests_status_createdAt_idx" ON "local_browser_requests"("status", "createdAt");
CREATE INDEX "local_browser_requests_actorId_createdAt_idx" ON "local_browser_requests"("actorId", "createdAt");

ALTER TABLE "local_browser_requests"
  ADD CONSTRAINT "local_browser_requests_taskId_fkey"
  FOREIGN KEY ("taskId") REFERENCES "local_tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;
