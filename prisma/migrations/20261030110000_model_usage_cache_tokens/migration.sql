-- 缓存命中的输入 token。DeepSeek 的命中价只有未命中价的 1/30（空闲 0.05 vs 1.5 元/百万），
-- 不单独记账就只能按未命中价估算，一天能高估三倍以上（2026-10-30 实测 0.99 元 vs 真实 0.34 元）。
-- 允许为 NULL：历史行与不返回缓存明细的供应商无法回填，语义是「未知」，不是「零命中」。

ALTER TABLE "model_usages" ADD COLUMN "cacheHitTokens" INTEGER;
ALTER TABLE "model_usages" ADD COLUMN "cacheMissTokens" INTEGER;
