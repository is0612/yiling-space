-- 知识生命周期第一阶段：
-- 1) 版本快照增加 action，区分「内容修订」与「归档/恢复/回收站」这类生命周期操作。
--    历史行回填为 CONTENT_EDIT（此前的快照都来自内容编辑或合并）。
-- 2) 知识状态收敛为 ACTIVE / ARCHIVED / TRASHED / MERGED 四种，用 CHECK 防止拼写漂移。
--    现有数据只有 ACTIVE，不会触发约束。

ALTER TABLE "knowledge_item_revisions"
  ADD COLUMN "action" VARCHAR(20) NOT NULL DEFAULT 'CONTENT_EDIT';

ALTER TABLE "knowledge_item_revisions"
  ADD CONSTRAINT "knowledge_item_revisions_action_check"
  CHECK ("action" IN ('CONTENT_EDIT', 'MERGE', 'ARCHIVE', 'UNARCHIVE', 'TRASH', 'RESTORE'));

ALTER TABLE "knowledge_items"
  ADD CONSTRAINT "knowledge_items_status_check"
  CHECK ("status" IN ('ACTIVE', 'ARCHIVED', 'TRASHED', 'MERGED'));
