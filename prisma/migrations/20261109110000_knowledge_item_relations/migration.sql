-- Persist duplicate/conflict links and merge lineage between formal knowledge items.
CREATE TABLE "knowledge_item_relations" (
  "id" UUID NOT NULL,
  "characterId" UUID NOT NULL,
  "sourceItemId" UUID NOT NULL,
  "targetItemId" UUID NOT NULL,
  "relationType" VARCHAR(20) NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'OPEN',
  "resolution" VARCHAR(40),
  "metadata" JSONB,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  "resolvedAt" TIMESTAMPTZ(6),
  CONSTRAINT "knowledge_item_relations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "knowledge_item_relations_not_self_check" CHECK ("sourceItemId" <> "targetItemId"),
  CONSTRAINT "knowledge_item_relations_type_check" CHECK ("relationType" IN ('DUPLICATE', 'CONFLICT', 'MERGED_INTO')),
  CONSTRAINT "knowledge_item_relations_status_check" CHECK ("status" IN ('OPEN', 'RESOLVED', 'DISMISSED'))
);

CREATE UNIQUE INDEX "knowledge_item_relations_character_source_target_type_key"
  ON "knowledge_item_relations"("characterId", "sourceItemId", "targetItemId", "relationType");
CREATE INDEX "knowledge_item_relations_character_status_createdAt_idx"
  ON "knowledge_item_relations"("characterId", "status", "createdAt");
CREATE INDEX "knowledge_item_relations_source_status_idx"
  ON "knowledge_item_relations"("sourceItemId", "status");
CREATE INDEX "knowledge_item_relations_target_status_idx"
  ON "knowledge_item_relations"("targetItemId", "status");

ALTER TABLE "knowledge_item_relations"
  ADD CONSTRAINT "knowledge_item_relations_characterId_fkey"
  FOREIGN KEY ("characterId") REFERENCES "characters"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "knowledge_item_relations"
  ADD CONSTRAINT "knowledge_item_relations_sourceItemId_fkey"
  FOREIGN KEY ("sourceItemId") REFERENCES "knowledge_items"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "knowledge_item_relations"
  ADD CONSTRAINT "knowledge_item_relations_targetItemId_fkey"
  FOREIGN KEY ("targetItemId") REFERENCES "knowledge_items"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- A relation may only connect two items owned by the same character.
CREATE OR REPLACE FUNCTION "check_knowledge_item_relation_character"() RETURNS trigger AS $$
DECLARE
  source_character UUID;
  target_character UUID;
BEGIN
  SELECT "characterId" INTO source_character FROM "knowledge_items" WHERE "id" = NEW."sourceItemId";
  SELECT "characterId" INTO target_character FROM "knowledge_items" WHERE "id" = NEW."targetItemId";
  IF source_character IS NULL OR target_character IS NULL
     OR source_character <> NEW."characterId"
     OR target_character <> NEW."characterId" THEN
    RAISE EXCEPTION 'knowledge relation items must belong to relation character';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "knowledge_item_relations_character_guard"
  BEFORE INSERT OR UPDATE OF "characterId", "sourceItemId", "targetItemId"
  ON "knowledge_item_relations"
  FOR EACH ROW EXECUTE FUNCTION "check_knowledge_item_relation_character"();
