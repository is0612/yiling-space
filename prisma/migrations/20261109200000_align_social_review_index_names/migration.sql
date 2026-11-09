-- Align PostgreSQL index names with Prisma's generated names.
-- This is a naming-only migration: index definitions and indexed data do not change.
ALTER INDEX "social_relationship_assessment_reviews_assessmentId_createdAt_idx"
  RENAME TO "social_relationship_assessment_reviews_assessmentId_created_idx";

ALTER INDEX "social_relationship_assessment_reviews_reviewerUserId_createdAt_idx"
  RENAME TO "social_relationship_assessment_reviews_reviewerUserId_creat_idx";
