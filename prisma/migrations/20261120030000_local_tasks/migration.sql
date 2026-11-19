CREATE TABLE "local_tasks" (
    "id" UUID NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "goal" TEXT NOT NULL,
    "plan" TEXT NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'PLANNED',
    "actorId" UUID NOT NULL,
    "characterId" UUID,
    "conversationId" UUID,
    "resultNote" VARCHAR(1000),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "completedAt" TIMESTAMPTZ(6),
    CONSTRAINT "local_tasks_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "local_task_evidence" (
    "id" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "kind" VARCHAR(20) NOT NULL DEFAULT 'MANUAL',
    "outcome" VARCHAR(20) NOT NULL,
    "note" TEXT NOT NULL,
    "actorId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "local_task_evidence_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "local_write_requests" ADD COLUMN "taskId" UUID;

CREATE INDEX "local_tasks_status_createdAt_idx" ON "local_tasks"("status", "createdAt");
CREATE INDEX "local_task_evidence_taskId_createdAt_idx" ON "local_task_evidence"("taskId", "createdAt");
CREATE INDEX "local_write_requests_taskId_createdAt_idx" ON "local_write_requests"("taskId", "createdAt");

ALTER TABLE "local_task_evidence" ADD CONSTRAINT "local_task_evidence_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "local_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "local_write_requests" ADD CONSTRAINT "local_write_requests_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "local_tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;
