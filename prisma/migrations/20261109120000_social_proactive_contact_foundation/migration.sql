-- Separate proactive-contact authorization from the ordinary friend chat policy.
CREATE TYPE "SocialProactiveContactAttemptStatus" AS ENUM ('SENT', 'SKIPPED', 'FAILED', 'EXPIRED');

ALTER TABLE "memory_scopes"
  ADD COLUMN "proactiveContactEnabled" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "social_proactive_contact_attempts" (
  "id" UUID NOT NULL,
  "scopeId" UUID NOT NULL,
  "status" "SocialProactiveContactAttemptStatus" NOT NULL,
  "reason" VARCHAR(80) NOT NULL,
  "groupId" VARCHAR(64),
  "content" TEXT,
  "dedupeKey" VARCHAR(255),
  "attemptedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sentAt" TIMESTAMPTZ(6),
  "metadata" JSONB,
  CONSTRAINT "social_proactive_contact_attempts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "social_proactive_contact_attempts_scopeId_dedupeKey_key"
  ON "social_proactive_contact_attempts"("scopeId", "dedupeKey");
CREATE INDEX "social_proactive_contact_attempts_scopeId_attemptedAt_idx"
  ON "social_proactive_contact_attempts"("scopeId", "attemptedAt");
CREATE INDEX "social_proactive_contact_attempts_status_attemptedAt_idx"
  ON "social_proactive_contact_attempts"("status", "attemptedAt");

ALTER TABLE "social_proactive_contact_attempts"
  ADD CONSTRAINT "social_proactive_contact_attempts_scopeId_fkey"
  FOREIGN KEY ("scopeId") REFERENCES "memory_scopes"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
