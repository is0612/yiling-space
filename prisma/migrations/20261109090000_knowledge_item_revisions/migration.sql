-- Keep superseded formal knowledge versions for audit and safe correction.
CREATE TABLE "knowledge_item_revisions" (
  "id" UUID NOT NULL,
  "itemId" UUID NOT NULL,
  "revision" INTEGER NOT NULL,
  "title" VARCHAR(240) NOT NULL,
  "content" TEXT NOT NULL,
  "category" VARCHAR(40) NOT NULL,
  "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "confidence" DOUBLE PRECISION,
  "status" VARCHAR(20) NOT NULL,
  "sourceType" VARCHAR(20) NOT NULL,
  "sourceRef" JSONB,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "knowledge_item_revisions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "knowledge_item_revisions_itemId_revision_key"
  ON "knowledge_item_revisions"("itemId", "revision");
CREATE INDEX "knowledge_item_revisions_itemId_createdAt_idx"
  ON "knowledge_item_revisions"("itemId", "createdAt");

ALTER TABLE "knowledge_item_revisions"
  ADD CONSTRAINT "knowledge_item_revisions_itemId_fkey"
  FOREIGN KEY ("itemId") REFERENCES "knowledge_items"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
