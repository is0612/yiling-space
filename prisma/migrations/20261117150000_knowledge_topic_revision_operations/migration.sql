ALTER TABLE "knowledge_topic_revisions"
  ADD COLUMN "action" VARCHAR(20) NOT NULL DEFAULT 'EDIT',
  ADD COLUMN "operationId" UUID,
  ADD COLUMN "relatedTopicId" UUID;

CREATE INDEX "knowledge_topic_revisions_operationId_idx"
  ON "knowledge_topic_revisions"("operationId");
