-- 无人值守续办：每个任务一个开关和已用轮次，方便设上限与审计。
ALTER TABLE "local_tasks" ADD COLUMN "autoContinue" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "local_tasks" ADD COLUMN "autoRounds" INTEGER NOT NULL DEFAULT 0;
