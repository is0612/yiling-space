CREATE TYPE "KnowledgeTopicRunStatus" AS ENUM ('QUEUED', 'PROCESSING', 'READY', 'FAILED', 'STALE');
CREATE TYPE "KnowledgeTopicSuggestionStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DISMISSED');
CREATE TYPE "KnowledgeTopicStatus" AS ENUM ('ACTIVE', 'ARCHIVED', 'MERGED');

CREATE TABLE "knowledge_topic_runs" (
  "id" UUID NOT NULL,
  "characterId" UUID NOT NULL,
  "status" "KnowledgeTopicRunStatus" NOT NULL DEFAULT 'QUEUED',
  "inputSnapshot" JSONB NOT NULL,
  "ungroupedIds" JSONB NOT NULL DEFAULT '[]',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 3,
  "runAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseToken" UUID,
  "leaseExpiresAt" TIMESTAMPTZ(6),
  "fencingToken" INTEGER NOT NULL DEFAULT 0,
  "model" VARCHAR(120),
  "promptVersion" VARCHAR(80),
  "lastError" VARCHAR(500),
  "completedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "knowledge_topic_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "knowledge_topic_runs_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "characters"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "knowledge_topic_runs_attempts_check" CHECK ("attemptCount" >= 0 AND "maxAttempts" > 0 AND "fencingToken" >= 0)
);
CREATE INDEX "knowledge_topic_runs_status_runAt_idx" ON "knowledge_topic_runs"("status", "runAt");
CREATE INDEX "knowledge_topic_runs_characterId_createdAt_idx" ON "knowledge_topic_runs"("characterId", "createdAt");

CREATE TABLE "knowledge_topic_suggestions" (
  "id" UUID NOT NULL,
  "runId" UUID NOT NULL,
  "name" VARCHAR(200) NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "reason" TEXT NOT NULL,
  "memberItemIds" JSONB NOT NULL,
  "acceptedMemberItemIds" JSONB,
  "status" "KnowledgeTopicSuggestionStatus" NOT NULL DEFAULT 'PENDING',
  "reviewedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "knowledge_topic_suggestions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "knowledge_topic_suggestions_runId_fkey" FOREIGN KEY ("runId") REFERENCES "knowledge_topic_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "knowledge_topic_suggestions_runId_status_idx" ON "knowledge_topic_suggestions"("runId", "status");

CREATE TABLE "knowledge_topics" (
  "id" UUID NOT NULL,
  "characterId" UUID NOT NULL,
  "name" VARCHAR(200) NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "status" "KnowledgeTopicStatus" NOT NULL DEFAULT 'ACTIVE',
  "revision" INTEGER NOT NULL DEFAULT 1,
  "mergedIntoId" UUID,
  "mergedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "knowledge_topics_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "knowledge_topics_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "characters"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "knowledge_topics_mergedIntoId_fkey" FOREIGN KEY ("mergedIntoId") REFERENCES "knowledge_topics"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "knowledge_topics_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "knowledge_topics_not_self_merged_check" CHECK ("mergedIntoId" IS NULL OR "mergedIntoId" <> "id")
);
CREATE INDEX "knowledge_topics_characterId_status_updatedAt_idx" ON "knowledge_topics"("characterId", "status", "updatedAt");
CREATE INDEX "knowledge_topics_mergedIntoId_idx" ON "knowledge_topics"("mergedIntoId");

CREATE TABLE "knowledge_topic_members" (
  "id" UUID NOT NULL,
  "topicId" UUID NOT NULL,
  "itemId" UUID NOT NULL,
  "itemRevision" INTEGER NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "knowledge_topic_members_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "knowledge_topic_members_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "knowledge_topics"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "knowledge_topic_members_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "knowledge_items"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "knowledge_topic_members_revision_check" CHECK ("itemRevision" > 0)
);
CREATE UNIQUE INDEX "knowledge_topic_members_topicId_itemId_key" ON "knowledge_topic_members"("topicId", "itemId");
CREATE INDEX "knowledge_topic_members_itemId_idx" ON "knowledge_topic_members"("itemId");
CREATE INDEX "knowledge_topic_members_topicId_createdAt_idx" ON "knowledge_topic_members"("topicId", "createdAt");

CREATE TABLE "knowledge_topic_revisions" (
  "id" UUID NOT NULL,
  "topicId" UUID NOT NULL,
  "revision" INTEGER NOT NULL,
  "name" VARCHAR(200) NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "status" "KnowledgeTopicStatus" NOT NULL,
  "mergedIntoId" UUID,
  "members" JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "knowledge_topic_revisions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "knowledge_topic_revisions_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "knowledge_topics"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "knowledge_topic_revisions_revision_check" CHECK ("revision" > 0)
);
CREATE UNIQUE INDEX "knowledge_topic_revisions_topicId_revision_key" ON "knowledge_topic_revisions"("topicId", "revision");
CREATE INDEX "knowledge_topic_revisions_topicId_createdAt_idx" ON "knowledge_topic_revisions"("topicId", "createdAt");
