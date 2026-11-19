-- B站功能整体下线：删掉值班专用的五张表。
-- 旧迁移文件已同时移除，所以全新库不会创建它们；这里用 IF EXISTS 让已有库把历史表清掉。
-- 顺序按外键依赖从子到父（都指向 character_channel_bindings）。
DROP TABLE IF EXISTS "bili_duty_window_runs";
DROP TABLE IF EXISTS "bili_duty_leases";
DROP TABLE IF EXISTS "bili_actions";
DROP TABLE IF EXISTS "bili_seen_videos";
DROP TABLE IF EXISTS "bili_round_reports";
