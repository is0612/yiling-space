-- CreateEnum
CREATE TYPE "RelationshipStage" AS ENUM ('STRANGER', 'ACQUAINTANCE', 'FRIEND', 'CLOSE_FRIEND');

-- AlterTable
ALTER TABLE "memory_scopes"
  ADD COLUMN "relationshipStage" "RelationshipStage",
  ADD COLUMN "relationshipVersion" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "relationshipUpdatedAt" TIMESTAMPTZ(6);

-- Existing role-to-identity rows begin at STRANGER. Non-identity scopes remain NULL.
UPDATE "memory_scopes"
SET "relationshipStage" = 'STRANGER'
WHERE "scopeType" = 'EXTERNAL_IDENTITY';

-- CreateTable
CREATE TABLE "social_experiences" (
  "id" UUID NOT NULL,
  "scopeId" UUID NOT NULL,
  "memoryEventId" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "social_experiences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "social_relation_changes" (
  "id" UUID NOT NULL,
  "scopeId" UUID NOT NULL,
  "fromStage" "RelationshipStage" NOT NULL,
  "toStage" "RelationshipStage" NOT NULL,
  "reason" TEXT NOT NULL,
  "idempotencyKey" VARCHAR(500) NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "social_relation_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "social_relation_change_evidence" (
  "id" UUID NOT NULL,
  "changeId" UUID NOT NULL,
  "experienceId" UUID NOT NULL,
  CONSTRAINT "social_relation_change_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "social_experiences_scopeId_memoryEventId_key"
  ON "social_experiences"("scopeId", "memoryEventId");
CREATE INDEX "social_experiences_scopeId_createdAt_idx"
  ON "social_experiences"("scopeId", "createdAt");
CREATE INDEX "social_experiences_memoryEventId_idx"
  ON "social_experiences"("memoryEventId");

-- CreateIndex
CREATE UNIQUE INDEX "social_relation_changes_idempotencyKey_key"
  ON "social_relation_changes"("idempotencyKey");
CREATE INDEX "social_relation_changes_scopeId_createdAt_idx"
  ON "social_relation_changes"("scopeId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "social_relation_change_evidence_changeId_experienceId_key"
  ON "social_relation_change_evidence"("changeId", "experienceId");
CREATE INDEX "social_relation_change_evidence_experienceId_idx"
  ON "social_relation_change_evidence"("experienceId");

-- AddForeignKey
ALTER TABLE "social_experiences"
  ADD CONSTRAINT "social_experiences_scopeId_fkey"
  FOREIGN KEY ("scopeId") REFERENCES "memory_scopes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "social_experiences"
  ADD CONSTRAINT "social_experiences_memoryEventId_fkey"
  FOREIGN KEY ("memoryEventId") REFERENCES "memory_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_relation_changes"
  ADD CONSTRAINT "social_relation_changes_scopeId_fkey"
  FOREIGN KEY ("scopeId") REFERENCES "memory_scopes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_relation_change_evidence"
  ADD CONSTRAINT "social_relation_change_evidence_changeId_fkey"
  FOREIGN KEY ("changeId") REFERENCES "social_relation_changes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "social_relation_change_evidence"
  ADD CONSTRAINT "social_relation_change_evidence_experienceId_fkey"
  FOREIGN KEY ("experienceId") REFERENCES "social_experiences"("id") ON DELETE CASCADE ON UPDATE CASCADE;
