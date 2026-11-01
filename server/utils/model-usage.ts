/**
 * 模型调用的 token 记账与每日额度。
 *
 * 只统计、不拦截计费：额度是"别把一天的预算烧光"，不是计费系统。
 * 记账失败必须吞掉 —— 回复已经生成成功了，不能因为一行统计写失败就把用户的对话变成 500。
 */

import { estimateUsageCostCny, resolveModelPrice, resolveUsdCnyRate } from "./model-pricing";
import { getPrisma } from "./prisma";

export type ModelUsageKind = "chat" | "channel" | "snapshot" | "events" | "journal" | "bili-screening" | "bili-judge" | "proactive" | "vision" | "sticker-label" | "catchphrase-mine" | "other";

export type ModelUsageTokens = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
  /** 缓存命中的输入 token。undefined = 供应商没回传缓存明细（不是「零命中」）。 */
  cacheHitTokens?: number;
  cacheMissTokens?: number;
};

export type ModelUsageInput = {
  kind: ModelUsageKind;
  model: string;
  usage?: ModelUsageTokens | null;
  characterId?: string | null;
  userId?: string | null;
  conversationId?: string | null;
  channelBindingId?: string | null;
  /** 只收 JSON 可序列化的平铺值：Prisma 的 Json 字段不接受 unknown。 */
  metadata?: Record<string, string | number | boolean | null> | null;
};

export type DailyQuota = {
  /** 0 表示不限。 */
  limit: number;
  used: number;
  /** null = 不限额度（JSON 里不会把 Infinity 变成 null 误导前端）。 */
  remaining: number | null;
  exceeded: boolean;
};

function nonNegativeInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/**
 * 从 OpenAI 兼容响应的 `usage` 读 token。
 * 缺 `total_tokens` 时用 prompt+completion 补，但两者都没有就返回 null —— 不拿估算值冒充真实用量。
 */
export function readModelUsage(payload: unknown): ModelUsageTokens | null {
  const usage = asRecord(asRecord(payload).usage);
  if (!Object.keys(usage).length) return null;

  const promptTokens = nonNegativeInt(usage.prompt_tokens);
  const completionTokens = nonNegativeInt(usage.completion_tokens);
  const totalTokens = nonNegativeInt(usage.total_tokens) || promptTokens + completionTokens;
  if (totalTokens <= 0) return null;

  const details = asRecord(usage.completion_tokens_details);
  const reasoningTokens = nonNegativeInt(details.reasoning_tokens);

  // 缓存明细有两种写法：DeepSeek 的 prompt_cache_hit_tokens / prompt_cache_miss_tokens，
  // OpenAI 兼容层的 prompt_tokens_details.cached_tokens。
  // 两者都没有时留 undefined，不要填 0 —— 0 会被后续计价当成「全部未命中」，把未知说成已知。
  const promptDetails = asRecord(usage.prompt_tokens_details);
  const hitRaw = typeof usage.prompt_cache_hit_tokens === "number"
    ? usage.prompt_cache_hit_tokens
    : promptDetails.cached_tokens;
  const hasCacheDetail = typeof hitRaw === "number" || typeof usage.prompt_cache_miss_tokens === "number";
  const cacheHitTokens = typeof hitRaw === "number" ? Math.min(promptTokens, nonNegativeInt(hitRaw)) : undefined;
  const cacheMissTokens = hasCacheDetail
    ? Math.max(0, promptTokens - (cacheHitTokens ?? 0))
    : undefined;

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
    ...(hasCacheDetail ? { cacheHitTokens: cacheHitTokens ?? 0, cacheMissTokens: cacheMissTokens ?? promptTokens } : {}),
  };
}

/**
 * 把各调用点已经解析好的「宽松 usage」（字段都可选）归一化成记账用的结构。
 * 三个调用点（chat-reply / memory-ai / bili llm）各自解析出来都缺字段，统一走这里补零。
 */
export function toUsageTokens(
  input: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    reasoningTokens?: number;
    cacheHitTokens?: number;
    cacheMissTokens?: number;
  } | null | undefined,
): ModelUsageTokens | null {
  if (!input) return null;
  const promptTokens = nonNegativeInt(input.promptTokens);
  const completionTokens = nonNegativeInt(input.completionTokens);
  const totalTokens = nonNegativeInt(input.totalTokens) || promptTokens + completionTokens;
  if (totalTokens <= 0) return null;
  const reasoningTokens = nonNegativeInt(input.reasoningTokens);
  const hasCacheDetail = typeof input.cacheHitTokens === "number" || typeof input.cacheMissTokens === "number";
  const cacheHitTokens = hasCacheDetail
    ? Math.min(promptTokens, nonNegativeInt(input.cacheHitTokens))
    : undefined;
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
    ...(hasCacheDetail
      ? {
          cacheHitTokens: cacheHitTokens ?? 0,
          cacheMissTokens: Math.max(0, promptTokens - (cacheHitTokens ?? 0)),
        }
      : {}),
  };
}

export async function recordModelUsage(input: ModelUsageInput): Promise<void> {
  const usage = input.usage;
  if (!usage || usage.totalTokens <= 0) return;
  try {
    await getPrisma().modelUsage.create({
      data: {
        kind: input.kind,
        model: input.model.slice(0, 120),
        characterId: input.characterId || null,
        userId: input.userId || null,
        conversationId: input.conversationId || null,
        channelBindingId: input.channelBindingId || null,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
        reasoningTokens: usage.reasoningTokens ?? null,
        cacheHitTokens: usage.cacheHitTokens ?? null,
        cacheMissTokens: usage.cacheMissTokens ?? null,
        metadata: input.metadata ?? undefined,
      },
    });
  } catch (error) {
    console.error("[usage] 写入模型用量失败：", error instanceof Error ? error.message : String(error));
  }
}

/**
 * 日界固定东八区：与 B站 值班的 `toDayKey` 用同一套「今天」，
 * 否则同一时刻会出现两个日期，额度与值班额度对不上。
 */
export function usageDayKey(date: Date = new Date()): string {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function dayStart(day: string): Date {
  return new Date(`${day}T00:00:00+08:00`);
}

export function resolveDailyTokenLimit(modelConfig: unknown): number {
  const raw = asRecord(modelConfig).dailyTokenLimit;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(Math.round(raw), 100_000_000);
}

export type DailyUsageSummary = {
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  calls: number;
  byKind: Record<string, { totalTokens: number; calls: number }>;
};

export async function readDailyUsage(characterId: string, day: string = usageDayKey()): Promise<DailyUsageSummary> {
  const start = dayStart(day);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);

  const rows = await getPrisma().modelUsage.groupBy({
    by: ["kind"],
    where: { characterId, createdAt: { gte: start, lt: end } },
    _sum: { promptTokens: true, completionTokens: true, totalTokens: true },
    _count: { _all: true },
  });

  const summary: DailyUsageSummary = { totalTokens: 0, promptTokens: 0, completionTokens: 0, calls: 0, byKind: {} };
  for (const row of rows) {
    const total = row._sum.totalTokens ?? 0;
    const calls = row._count._all ?? 0;
    summary.totalTokens += total;
    summary.promptTokens += row._sum.promptTokens ?? 0;
    summary.completionTokens += row._sum.completionTokens ?? 0;
    summary.calls += calls;
    summary.byKind[row.kind] = { totalTokens: total, calls };
  }
  return summary;
}

export async function readDailyQuota(
  characterId: string,
  modelConfig: unknown,
  day: string = usageDayKey(),
): Promise<DailyQuota> {
  const limit = resolveDailyTokenLimit(modelConfig);
  const usage = await readDailyUsage(characterId, day);
  if (!limit) return { limit: 0, used: usage.totalTokens, remaining: null, exceeded: false };
  return {
    limit,
    used: usage.totalTokens,
    remaining: Math.max(0, limit - usage.totalTokens),
    exceeded: usage.totalTokens >= limit,
  };
}

// ── 多角色 × 按天的用量与花费（总览用） ─────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_REPORT_DAYS = 31;

export type UsageDaySummary = {
  day: string;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  calls: number;
  /** 已定价部分的估算花费，单位元。 */
  costCny: number;
  /** 未定价模型消耗的 token：这部分进不了 costCny，页面上必须说明金额不完整。 */
  unpricedTokens: number;
  /** 缓存命中的输入 token（只统计有明细的调用）。 */
  cacheHitTokens: number;
  /** 缓存未命中的输入 token。 */
  cacheMissTokens: number;
  /** 没有缓存明细的调用数：这些行按未命中价算，金额偏高。 */
  uncachedCalls: number;
};

export type CharacterUsageReport = {
  characterId: string;
  day: string;
  today: UsageDaySummary;
  /** 从旧到新，长度 = 请求的天数；没有用量的日子补零，页面才能画出等高间距的柱子。 */
  days: UsageDaySummary[];
  windowTokens: number;
  windowCostCny: number;
  /** 这段时间里出现过、但价目表里没有的模型名。 */
  unpricedModels: string[];
  /** 窗口内没有缓存明细的调用数；大于 0 时金额只会偏高。 */
  uncachedCalls: number;
};

/** 记账行里聚合需要的字段。抽成独立类型是为了让汇总逻辑能脱离数据库做回归测试。 */
export type UsageRowForReport = {
  characterId: string | null;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** null/undefined = 这次调用没有缓存明细。 */
  cacheHitTokens?: number | null;
  createdAt: Date;
};

function roundCost(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function emptyUsageDay(day: string): UsageDaySummary {
  return {
    day,
    totalTokens: 0,
    promptTokens: 0,
    completionTokens: 0,
    calls: 0,
    costCny: 0,
    unpricedTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    uncachedCalls: 0,
  };
}

/** 含今天在内、往前的 N 个东八区日期，从旧到新。 */
export function usageDayWindow(days: number, now: Date = new Date()): string[] {
  const count = Math.min(MAX_REPORT_DAYS, Math.max(1, Math.round(days)));
  const todayStart = dayStart(usageDayKey(now)).getTime();
  const list: string[] = [];
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    list.push(usageDayKey(new Date(todayStart - offset * DAY_MS)));
  }
  return list;
}

/**
 * 把记账行摊成「角色 × 天」的用量与花费。纯函数：计价、日界、补零都在这里定死，测试不需要数据库。
 * 计价按每一行自己的调用时间取价（DeepSeek 分高峰/空闲），不能先按天求和再统一乘单价。
 */
export function summarizeUsageRows(
  rows: UsageRowForReport[],
  options: {
    characterIds: string[];
    days: string[];
    env?: Record<string, string | undefined>;
  },
): Map<string, CharacterUsageReport> {
  const { days } = options;
  const env = options.env ?? process.env;
  const dayIndex = new Map(days.map((day, index) => [day, index]));
  const usdCnyRate = resolveUsdCnyRate(env);
  const buckets = new Map<string, { days: UsageDaySummary[]; unpricedModels: Set<string> }>();

  for (const characterId of options.characterIds) {
    buckets.set(characterId, { days: days.map(emptyUsageDay), unpricedModels: new Set() });
  }

  for (const row of rows) {
    if (!row.characterId) continue;
    const entry = buckets.get(row.characterId);
    if (!entry) continue;
    const index = dayIndex.get(usageDayKey(row.createdAt));
    if (index === undefined) continue;

    // days 按「今天往前」铺好，index 越界说明这行数据落在窗口外；直接跳过，
    // 别让一行脏数据把整份报表算成 NaN。
    const bucket = entry.days[index];
    if (!bucket) continue;
    const total = row.totalTokens > 0 ? row.totalTokens : row.promptTokens + row.completionTokens;
    bucket.totalTokens += total;
    bucket.promptTokens += row.promptTokens;
    bucket.completionTokens += row.completionTokens;
    bucket.calls += 1;

    const hasCacheDetail = typeof row.cacheHitTokens === "number";
    if (hasCacheDetail) {
      const hit = Math.min(row.promptTokens, Math.max(0, row.cacheHitTokens!));
      bucket.cacheHitTokens += hit;
      bucket.cacheMissTokens += Math.max(0, row.promptTokens - hit);
    } else {
      // 没有明细的调用按未命中价算，单独计数，页面据此提示「金额偏高」。
      bucket.uncachedCalls += 1;
      bucket.cacheMissTokens += row.promptTokens;
    }

    const price = resolveModelPrice(row.model, env);
    if (!price) {
      bucket.unpricedTokens += total;
      entry.unpricedModels.add(row.model);
      continue;
    }
    bucket.costCny += estimateUsageCostCny(
      price,
      {
        promptTokens: row.promptTokens,
        completionTokens: row.completionTokens,
        ...(hasCacheDetail ? { cacheHitTokens: row.cacheHitTokens! } : {}),
      },
      row.createdAt,
      usdCnyRate,
    );
  }

  const reports = new Map<string, CharacterUsageReport>();
  for (const [characterId, entry] of buckets) {
    const summarized = entry.days.map((bucket) => ({ ...bucket, costCny: roundCost(bucket.costCny) }));
    const today = summarized[summarized.length - 1] ?? emptyUsageDay(usageDayKey());
    reports.set(characterId, {
      characterId,
      day: today.day,
      today,
      days: summarized,
      windowTokens: summarized.reduce((sum, bucket) => sum + bucket.totalTokens, 0),
      windowCostCny: roundCost(summarized.reduce((sum, bucket) => sum + bucket.costCny, 0)),
      unpricedModels: [...entry.unpricedModels].sort(),
      uncachedCalls: summarized.reduce((sum, bucket) => sum + bucket.uncachedCalls, 0),
    });
  }
  return reports;
}

/**
 * 一次查出多个角色最近 N 天的用量并算好花费。
 * 调用点极少（只有总览），可以接受把 7 天的行全捞出来在内存里聚合：
 * 按「角色 + 模型 + 时段」分桶需要日期截断和分时判断，SQL 里做反而更脆。
 */
export async function readUsageReport(
  characterIds: string[],
  days = 7,
  now: Date = new Date(),
): Promise<Map<string, CharacterUsageReport>> {
  const ids = [...new Set(characterIds.filter((id) => Boolean(id)))];
  const dayKeys = usageDayWindow(days, now);
  if (!ids.length) return new Map();

  const start = dayStart(dayKeys[0]!);
  const end = new Date(dayStart(dayKeys[dayKeys.length - 1]!).getTime() + DAY_MS);

  const rows = await getPrisma().modelUsage.findMany({
    where: { characterId: { in: ids }, createdAt: { gte: start, lt: end } },
    select: {
      characterId: true,
      model: true,
      promptTokens: true,
      completionTokens: true,
      totalTokens: true,
      cacheHitTokens: true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" },
  });

  return summarizeUsageRows(rows, { characterIds: ids, days: dayKeys });
}
