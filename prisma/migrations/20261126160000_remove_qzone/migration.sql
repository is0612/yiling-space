-- QQ 空间功能整体下线：删掉空间动作（发说说 / 评论）这张表。
-- 旧迁移文件已同时移除，所以全新库不会创建它；这里用 IF EXISTS 让已有库把历史表清掉。
DROP TABLE IF EXISTS "onebot_qzone_actions";
