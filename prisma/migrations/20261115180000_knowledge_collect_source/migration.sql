-- 知识来源白名单：「谁的聊天值得记成知识」是角色 × 人这一层的关系属性，
-- 落在 memory_scopes 上，和主动联系授权、教育授权同构。
-- 默认 false：升级后已有角色仍是 ALL 模式，行为不变；只有显式切到 SELECTED 才读这一列。
ALTER TABLE "memory_scopes" ADD COLUMN "knowledgeCollectEnabled" BOOLEAN NOT NULL DEFAULT false;
