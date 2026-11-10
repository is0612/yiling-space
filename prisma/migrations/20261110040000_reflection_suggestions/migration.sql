CREATE TYPE "ReflectionRunStatus" AS ENUM ('QUEUED','RUNNING','SUCCEEDED','FAILED');
CREATE TYPE "ReflectionSuggestionStatus" AS ENUM ('PENDING','ACCEPTED','REJECTED','DEFERRED');
CREATE TABLE "reflection_runs" (
  "id" UUID NOT NULL, "characterId" UUID NOT NULL, "requestKey" UUID NOT NULL,
  "periodStart" TIMESTAMPTZ(6) NOT NULL, "periodEnd" TIMESTAMPTZ(6) NOT NULL,
  "status" "ReflectionRunStatus" NOT NULL DEFAULT 'QUEUED', "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 3, "runAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseToken" UUID, "leaseExpiresAt" TIMESTAMPTZ(6), "fencingToken" INTEGER NOT NULL DEFAULT 0,
  "lastError" VARCHAR(500), "model" VARCHAR(120), "promptVersion" VARCHAR(80),
  "completedAt" TIMESTAMPTZ(6), "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "reflection_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "reflection_runs_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "characters"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "reflection_runs_attempts_check" CHECK ("attemptCount">=0 AND "maxAttempts">0 AND "fencingToken">=0),
  CONSTRAINT "reflection_runs_period_check" CHECK ("periodStart" < "periodEnd")
);
CREATE UNIQUE INDEX "reflection_runs_characterId_requestKey_key" ON "reflection_runs"("characterId","requestKey");
CREATE INDEX "reflection_runs_status_runAt_idx" ON "reflection_runs"("status","runAt");
CREATE INDEX "reflection_runs_characterId_createdAt_idx" ON "reflection_runs"("characterId","createdAt");
CREATE TABLE "reflection_suggestions" (
  "id" UUID NOT NULL, "runId" UUID NOT NULL, "title" VARCHAR(200) NOT NULL,
  "observation" TEXT NOT NULL, "inference" TEXT NOT NULL, "recommendation" TEXT NOT NULL, "sourceRefs" JSONB NOT NULL,
  "status" "ReflectionSuggestionStatus" NOT NULL DEFAULT 'PENDING', "reviewNote" VARCHAR(500),
  "reviewedAt" TIMESTAMPTZ(6), "acceptedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "reflection_suggestions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "reflection_suggestions_runId_fkey" FOREIGN KEY ("runId") REFERENCES "reflection_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "reflection_suggestions_runId_status_idx" ON "reflection_suggestions"("runId","status");
