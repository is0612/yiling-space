-- 忆泡按天产出：和 8 天快照周期解耦。
--
-- 之前忆泡只在周期快照任务里顺带提炼，「前天我做了什么」要等下一个 8 天周期
-- 才可能答得出。这里新增一个独立任务类型：每天处理「昨天」一整天。
ALTER TYPE "MemoryJobType" ADD VALUE 'EXTRACT_EVENTS';
