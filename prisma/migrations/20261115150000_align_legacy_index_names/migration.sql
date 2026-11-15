-- 把 4 张表上 6 个索引名对齐到 Prisma 计算出的名字（只改标识符，不动数据、不动索引定义）。
--
-- 成因：早期迁移手写了这些约束的完整默认名（例如
-- ..._characterId_domain_localId_key，66 字节），PostgreSQL 会把超过 63 字节的标识符
-- 直接截断成 ..._localId_k；而 Prisma 自己算名字时会先保留后缀再截前缀，得到
-- ..._local_key。两边指向同一个索引、同样的列，只是名字不同，于是 migrate diff
-- 每次报 6 条「重命名」。
--
-- 这里选择「改数据库名字」而不是在 schema 里写 map：schema 保持 Prisma 默认命名，
-- 以后任何新库按默认名建索引都能对上；如果反过来把截断后的名字写进 schema，
-- 等于把 PostgreSQL 的截断结果固化成一个需要长期维护的别名。
--
-- 两侧都是 63 字节，重命名不会再次被截断。

-- character_growth_import_identities
ALTER INDEX "character_growth_import_identities_characterId_domain_localId_k"
  RENAME TO "character_growth_import_identities_characterId_domain_local_key";
ALTER INDEX "character_growth_import_identities_characterId_domain_originId_"
  RENAME TO "character_growth_import_identities_characterId_domain_origi_key";

-- interaction_experiences
ALTER INDEX "interaction_experiences_characterId_conversationId_memorySco_id"
  RENAME TO "interaction_experiences_characterId_conversationId_memorySc_idx";
ALTER INDEX "interaction_experiences_conversationId_assistantMessageId_fee_k"
  RENAME TO "interaction_experiences_conversationId_assistantMessageId_f_key";

-- memory_knowledge_candidate_requests
ALTER INDEX "memory_knowledge_candidate_requests_characterId_memoryEventId_k"
  RENAME TO "memory_knowledge_candidate_requests_characterId_memoryEvent_key";
ALTER INDEX "memory_knowledge_candidate_requests_characterId_status_createdA"
  RENAME TO "memory_knowledge_candidate_requests_characterId_status_crea_idx";
