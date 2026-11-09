-- Human review lifecycle for social relationship assessment suggestions.
CREATE TYPE "SocialRelationshipAssessmentReviewStatus" AS ENUM (
  'NOT_REQUIRED',
  'PENDING',
  'DEFERRED',
  'ACCEPTED',
  'REJECTED',
  'STALE'
);

CREATE TYPE "SocialRelationshipAssessmentReviewDecision" AS ENUM (
  'DEFERRED',
  'ACCEPTED',
  'REJECTED',
  'STALE'
);

ALTER TABLE "social_relationship_assessments"
  ADD COLUMN "reviewStatus" "SocialRelationshipAssessmentReviewStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
  ADD COLUMN "reviewedAt" TIMESTAMPTZ(6),
  ADD COLUMN "reviewedByUserId" UUID;

CREATE INDEX "social_relationship_assessments_reviewStatus_createdAt_idx"
  ON "social_relationship_assessments"("reviewStatus", "createdAt");

CREATE TABLE "social_relationship_assessment_reviews" (
  "id" UUID NOT NULL,
  "assessmentId" UUID NOT NULL,
  "reviewerUserId" UUID NOT NULL,
  "decision" "SocialRelationshipAssessmentReviewDecision" NOT NULL,
  "note" TEXT,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "social_relationship_assessment_reviews_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "social_relationship_assessment_reviews_assessmentId_createdAt_idx"
  ON "social_relationship_assessment_reviews"("assessmentId", "createdAt");
CREATE INDEX "social_relationship_assessment_reviews_reviewerUserId_createdAt_idx"
  ON "social_relationship_assessment_reviews"("reviewerUserId", "createdAt");

ALTER TABLE "social_relationship_assessment_reviews"
  ADD CONSTRAINT "social_relationship_assessment_reviews_assessmentId_fkey"
  FOREIGN KEY ("assessmentId") REFERENCES "social_relationship_assessments"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "social_relation_changes"
  ADD COLUMN "fromStatus" "SocialRelationshipStatus",
  ADD COLUMN "toStatus" "SocialRelationshipStatus",
  ADD COLUMN "relationshipVersionBefore" INTEGER,
  ADD COLUMN "relationshipVersionAfter" INTEGER,
  ADD COLUMN "assessmentId" UUID;

CREATE UNIQUE INDEX "social_relation_changes_assessmentId_key"
  ON "social_relation_changes"("assessmentId");

ALTER TABLE "social_relation_changes"
  ADD CONSTRAINT "social_relation_changes_assessmentId_fkey"
  FOREIGN KEY ("assessmentId") REFERENCES "social_relationship_assessments"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
