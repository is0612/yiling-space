-- 两阶段网页操作：第一阶段只填写并截图，第二阶段确认后才点提交。
ALTER TABLE "local_browser_requests" ADD COLUMN "submitSelector" VARCHAR(200);
