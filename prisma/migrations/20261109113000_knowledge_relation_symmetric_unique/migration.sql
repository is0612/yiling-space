-- 1) 对齐索引名：20261109110000 的迁移手写了短索引名，与 Prisma 生成的期望名不一致，
--    会让 `prisma migrate diff --exit-code`（CI 的 schema 漂移校验）持续报 RenameIndex 失败。
ALTER INDEX "knowledge_item_relations_character_source_target_type_key"
  RENAME TO "knowledge_item_relations_characterId_sourceItemId_targetIte_key";
ALTER INDEX "knowledge_item_relations_character_status_createdAt_idx"
  RENAME TO "knowledge_item_relations_characterId_status_createdAt_idx";
ALTER INDEX "knowledge_item_relations_source_status_idx"
  RENAME TO "knowledge_item_relations_sourceItemId_status_idx";
ALTER INDEX "knowledge_item_relations_target_status_idx"
  RENAME TO "knowledge_item_relations_targetItemId_status_idx";

-- 2) 对称关系去重的硬约束。
--    DUPLICATE / CONFLICT 是无向关系，只靠 (characterId, sourceItemId, targetItemId, relationType)
--    无法拦住 A→B 与 B→A 并存，因此按无序对 (LEAST, GREATEST) 再建一条部分唯一索引。
--    MERGED_INTO 是有向归并关系，不在此索引覆盖范围内，仍由上面那条普通唯一索引约束。
--    Prisma schema 无法表达表达式/部分索引，索引只存在于迁移中；migrate diff 会忽略它，不会误报漂移。
CREATE UNIQUE INDEX "knowledge_item_relations_symmetric_pair_key"
  ON "knowledge_item_relations" (
    "characterId",
    LEAST("sourceItemId", "targetItemId"),
    GREATEST("sourceItemId", "targetItemId"),
    "relationType"
  )
  WHERE "relationType" IN ('DUPLICATE', 'CONFLICT');
