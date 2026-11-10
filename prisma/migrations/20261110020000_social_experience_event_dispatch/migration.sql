-- Existing and backfilled experiences retain the legacy maintenance path.
-- Live experiences opt into durable event dispatch explicitly.
CREATE TYPE "SocialExperienceAssessmentDispatchStatus" AS ENUM ('LEGACY', 'PENDING', 'QUEUED');
ALTER TABLE "social_experiences"
  ADD COLUMN "assessmentDispatchStatus" "SocialExperienceAssessmentDispatchStatus" NOT NULL DEFAULT 'LEGACY';
