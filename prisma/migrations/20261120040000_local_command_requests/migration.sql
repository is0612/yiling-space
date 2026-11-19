CREATE TABLE "local_command_requests" (
    "id" UUID NOT NULL,
    "rootId" UUID NOT NULL,
    "taskId" UUID,
    "command" VARCHAR(200) NOT NULL,
    "args" JSONB NOT NULL DEFAULT '[]',
    "cwd" VARCHAR(1000) NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "exitCode" INTEGER,
    "stdout" TEXT,
    "stderr" TEXT,
    "durationMs" INTEGER,
    "actorId" UUID NOT NULL,
    "characterId" UUID,
    "conversationId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMPTZ(6),
    "startedAt" TIMESTAMPTZ(6),
    "finishedAt" TIMESTAMPTZ(6),
    "error" VARCHAR(500),
    CONSTRAINT "local_command_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "local_command_requests_status_createdAt_idx" ON "local_command_requests"("status", "createdAt");
CREATE INDEX "local_command_requests_rootId_createdAt_idx" ON "local_command_requests"("rootId", "createdAt");
CREATE INDEX "local_command_requests_taskId_createdAt_idx" ON "local_command_requests"("taskId", "createdAt");
ALTER TABLE "local_command_requests" ADD CONSTRAINT "local_command_requests_rootId_fkey" FOREIGN KEY ("rootId") REFERENCES "local_access_roots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "local_command_requests" ADD CONSTRAINT "local_command_requests_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "local_tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;
