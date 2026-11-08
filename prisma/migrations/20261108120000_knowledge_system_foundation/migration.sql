-- Knowledge candidates and approved knowledge are stored separately.
CREATE TABLE "knowledge_candidates" (
  "id" UUID NOT NULL,
  "characterId" UUID NOT NULL,
  "sourceType" VARCHAR(20) NOT NULL DEFAULT 'MANUAL',
  "sourceRef" JSONB,
  "rawContent" TEXT NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  "processedResult" JSONB,
  "processingError" TEXT,
  "processedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "knowledge_candidates_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "knowledge_items" (
  "id" UUID NOT NULL,
  "characterId" UUID NOT NULL,
  "candidateId" UUID,
  "title" VARCHAR(240) NOT NULL,
  "content" TEXT NOT NULL,
  "category" VARCHAR(40) NOT NULL DEFAULT 'GENERAL',
  "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "confidence" DOUBLE PRECISION,
  "status" VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  "sourceType" VARCHAR(20) NOT NULL DEFAULT 'MANUAL',
  "sourceRef" JSONB,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "knowledge_items_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "knowledge_items_candidateId_key" ON "knowledge_items"("candidateId");
CREATE INDEX "knowledge_candidates_characterId_status_createdAt_idx"
  ON "knowledge_candidates"("characterId", "status", "createdAt");
CREATE INDEX "knowledge_candidates_characterId_createdAt_idx"
  ON "knowledge_candidates"("characterId", "createdAt");
CREATE INDEX "knowledge_items_characterId_status_updatedAt_idx"
  ON "knowledge_items"("characterId", "status", "updatedAt");
CREATE INDEX "knowledge_items_characterId_category_status_idx"
  ON "knowledge_items"("characterId", "category", "status");

ALTER TABLE "knowledge_candidates"
  ADD CONSTRAINT "knowledge_candidates_characterId_fkey"
  FOREIGN KEY ("characterId") REFERENCES "characters"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "knowledge_items"
  ADD CONSTRAINT "knowledge_items_characterId_fkey"
  FOREIGN KEY ("characterId") REFERENCES "characters"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "knowledge_items"
  ADD CONSTRAINT "knowledge_items_candidateId_fkey"
  FOREIGN KEY ("candidateId") REFERENCES "knowledge_candidates"("id") ON DELETE SET NULL ON UPDATE CASCADE;
