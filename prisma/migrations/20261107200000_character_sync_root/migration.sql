-- 统一角色跨设备身份：本机原生角色以自己的实例 id 作为同步根。
-- 已有非空 originCharacterId 表示此前导入的同步根，必须原样保留。

UPDATE "characters"
SET "originCharacterId" = "id"
WHERE "originCharacterId" IS NULL;
