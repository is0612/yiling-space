-- 角色「停用」在本迁移之前是没有行为含义的：`POST /api/characters` 一律以 PAUSED 建角色，
-- 但聊天、渠道回复、B站 值班都不检查 status，所以「已暂停」只是界面标签。
--
-- 从本次起 status 真正生效：PAUSED/ARCHIVED 的角色不再回复对话与渠道消息，也不再跑值班。
-- 为了让存量角色保持「和以前一样能用」，把所有 PAUSED 统一回 ACTIVE —— 它们当初只是被默认值
-- 落在 PAUSED，没有一个是用户主动停用的。ARCHIVED 不动（那是 DELETE 之外的显式归档态）。
UPDATE "characters" SET "status" = 'ACTIVE' WHERE "status" = 'PAUSED';
