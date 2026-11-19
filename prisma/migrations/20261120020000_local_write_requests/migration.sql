CREATE TABLE "local_write_requests" (
    "id" UUID NOT NULL,
    "rootId" UUID NOT NULL,
    "relativePath" VARCHAR(1000) NOT NULL,
    "content" TEXT NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "baseHash" VARCHAR(64),
    "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "actorId" UUID NOT NULL,
    "characterId" UUID,
    "conversationId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMPTZ(6),
    "appliedAt" TIMESTAMPTZ(6),
    "error" VARCHAR(500),
    CONSTRAINT "local_write_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "local_write_requests_status_createdAt_idx" ON "local_write_requests"("status", "createdAt");
CREATE INDEX "local_write_requests_rootId_createdAt_idx" ON "local_write_requests"("rootId", "createdAt");
ALTER TABLE "local_write_requests" ADD CONSTRAINT "local_write_requests_rootId_fkey" FOREIGN KEY ("rootId") REFERENCES "local_access_roots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
