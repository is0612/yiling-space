-- AlterTable
-- 归档周期默认值 8 → 2 天（2026-11-03）。上限同时从 365 收到 8（应用层校验）。
-- 已有行不动：存量角色仍是 8，正好落在新上限内，不需要数据迁移。
ALTER TABLE "character_memory_settings" ALTER COLUMN "snapshotIntervalDays" SET DEFAULT 2;
