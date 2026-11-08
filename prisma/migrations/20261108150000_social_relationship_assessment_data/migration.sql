-- Relationship status is orthogonal to relationship stage.
CREATE TYPE "SocialRelationshipStatus" AS ENUM ('NORMAL', 'DISTANT', 'CONFLICT', 'REPAIRING', 'UNOBSERVED');
CREATE TYPE "SocialRelationshipAssessmentTaskStatus" AS ENUM ('QUEUED', 'RUNNING', 'RETRY_WAIT', 'FAILED', 'PAUSED');
CREATE TYPE "SocialRelationshipAssessmentStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED');
CREATE TYPE "SocialRelationshipAssessmentOutcome" AS ENUM ('CHANGE', 'MAINTAIN', 'INSUFFICIENT', 'REVIEW');
CREATE TYPE "SocialRelationshipAssessmentEvidenceKind" AS ENUM ('NEW', 'CONTEXT');

ALTER TABLE "memory_scopes"
  ADD COLUMN "relationshipStatus" "SocialRelationshipStatus";

UPDATE "memory_scopes"
SET "relationshipStatus" = 'UNOBSERVED'
WHERE "scopeType" = 'EXTERNAL_IDENTITY';

CREATE TABLE "social_relationship_assessment_tasks" (
  "id" UUID NOT NULL,
  "scopeId" UUID NOT NULL,
  "status" "SocialRelationshipAssessmentTaskStatus" NOT NULL DEFAULT 'QUEUED',
  "triggerReasons" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "generation" INTEGER NOT NULL DEFAULT 0,
  "processedGeneration" INTEGER NOT NULL DEFAULT 0,
  "priority" INTEGER NOT NULL DEFAULT 0,
  "runAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 3,
  "lockedAt" TIMESTAMPTZ(6),
  "lockedBy" VARCHAR(255),
  "leaseToken" UUID,
  "leaseExpiresAt" TIMESTAMPTZ(6),
  "fencingToken" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "lastAssessedAt" TIMESTAMPTZ(6),
  "nextReviewAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "social_relationship_assessment_tasks_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "social_relationship_assessments" (
  "id" UUID NOT NULL,
  "scopeId" UUID NOT NULL,
  "generation" INTEGER NOT NULL,
  "triggerReasons" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "evaluatedStage" "RelationshipStage" NOT NULL,
  "evaluatedStatus" "SocialRelationshipStatus" NOT NULL,
  "relationshipVersion" INTEGER NOT NULL,
  "outcome" "SocialRelationshipAssessmentOutcome",
  "suggestedStage" "RelationshipStage",
  "suggestedStatus" "SocialRelationshipStatus",
  "reason" TEXT,
  "observations" JSONB,
  "confidence" DOUBLE PRECISION,
  "modelProvider" VARCHAR(80),
  "modelName" VARCHAR(160),
  "promptVersion" VARCHAR(80),
  "inputCutoffAt" TIMESTAMPTZ(6),
  "status" "SocialRelationshipAssessmentStatus" NOT NULL DEFAULT 'RUNNING',
  "error" TEXT,
  "startedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "social_relationship_assessments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "social_relationship_assessment_evidence" (
  "id" UUID NOT NULL,
  "assessmentId" UUID NOT NULL,
  "experienceId" UUID NOT NULL,
  "scopeId" UUID NOT NULL,
  "kind" "SocialRelationshipAssessmentEvidenceKind" NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "social_relationship_assessment_evidence_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "social_relationship_assessment_tasks_scopeId_key"
  ON "social_relationship_assessment_tasks"("scopeId");
CREATE INDEX "social_relationship_assessment_tasks_status_runAt_idx"
  ON "social_relationship_assessment_tasks"("status", "runAt");
CREATE INDEX "social_relationship_assessment_tasks_status_priority_runAt_idx"
  ON "social_relationship_assessment_tasks"("status", "priority", "runAt");

CREATE UNIQUE INDEX "social_experiences_id_scopeId_key"
  ON "social_experiences"("id", "scopeId");
CREATE UNIQUE INDEX "social_relationship_assessments_id_scopeId_key"
  ON "social_relationship_assessments"("id", "scopeId");

CREATE INDEX "social_relationship_assessments_scopeId_createdAt_idx"
  ON "social_relationship_assessments"("scopeId", "createdAt");
CREATE INDEX "social_relationship_assessments_scopeId_relationshipVersion_idx"
  ON "social_relationship_assessments"("scopeId", "relationshipVersion");
CREATE INDEX "social_relationship_assessments_status_createdAt_idx"
  ON "social_relationship_assessments"("status", "createdAt");

CREATE UNIQUE INDEX "social_relationship_assessment_evidence_assessmentId_experienceId_key"
  ON "social_relationship_assessment_evidence"("assessmentId", "experienceId");
CREATE INDEX "social_relationship_assessment_evidence_experienceId_kind_idx"
  ON "social_relationship_assessment_evidence"("experienceId", "kind");
CREATE INDEX "social_relationship_assessment_evidence_assessmentId_kind_idx"
  ON "social_relationship_assessment_evidence"("assessmentId", "kind");

ALTER TABLE "social_relationship_assessment_tasks"
  ADD CONSTRAINT "social_relationship_assessment_tasks_scopeId_fkey"
  FOREIGN KEY ("scopeId") REFERENCES "memory_scopes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "social_relationship_assessments"
  ADD CONSTRAINT "social_relationship_assessments_scopeId_fkey"
  FOREIGN KEY ("scopeId") REFERENCES "memory_scopes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "social_relationship_assessment_evidence"
  ADD CONSTRAINT "social_relationship_assessment_evidence_assessment_scope_fkey"
  FOREIGN KEY ("assessmentId", "scopeId") REFERENCES "social_relationship_assessments"("id", "scopeId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "social_relationship_assessment_evidence"
  ADD CONSTRAINT "social_relationship_assessment_evidence_experience_scope_fkey"
  FOREIGN KEY ("experienceId", "scopeId") REFERENCES "social_experiences"("id", "scopeId") ON DELETE CASCADE ON UPDATE CASCADE;
