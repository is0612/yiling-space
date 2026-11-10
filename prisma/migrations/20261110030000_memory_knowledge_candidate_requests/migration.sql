CREATE TYPE "MemoryKnowledgeRequestStatus" AS ENUM ('PENDING', 'CREATED', 'SKIPPED');
CREATE TABLE "memory_knowledge_candidate_requests" (
  "id" UUID NOT NULL,
  "characterId" UUID NOT NULL,
  "memoryEventId" UUID NOT NULL,
  "excerpt" TEXT NOT NULL,
  "sourceHash" VARCHAR(64) NOT NULL,
  "reason" VARCHAR(240) NOT NULL,
  "status" "MemoryKnowledgeRequestStatus" NOT NULL DEFAULT 'PENDING',
  "candidateId" UUID,
  "growthEventId" UUID,
  "skipReason" VARCHAR(500),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "memory_knowledge_candidate_requests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "memory_knowledge_candidate_requests_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "characters"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "memory_knowledge_candidate_requests_characterId_memoryEventId_key" ON "memory_knowledge_candidate_requests"("characterId", "memoryEventId");
CREATE INDEX "memory_knowledge_candidate_requests_characterId_status_createdAt_idx" ON "memory_knowledge_candidate_requests"("characterId", "status", "createdAt");
