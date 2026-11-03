-- AlterTable
-- 归档周期默认值 2 → 3 天（2026-11-03）。上限仍为 8（应用层校验）。
-- 已有行不动：存量角色沿用各自已存的周期，默认值只影响新建角色。
ALTER TABLE "character_memory_settings" ALTER COLUMN "snapshotIntervalDays" SET DEFAULT 3;
