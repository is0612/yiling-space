import { createError } from "h3";
import type { Prisma } from "../../src/generated/prisma/client";
import { estimateUsageCostCny, resolveModelPrice } from "./model-pricing";
import { getPrisma } from "./prisma";
import { usageDayWindow } from "./model-usage";

export const MODEL_CALL_LOG_KINDS = ["chat", "channel", "snapshot", "events", "journal", "bili-screening", "bili-judge", "bili-owner", "proactive", "vision", "sticker-label", "catchphrase-mine", "memory-assistant", "context-assistant", "other"] as const;
const SUCCESS_STATUSES = ["success", "no_sources", "context_answered"] as const;
const FAILED_STATUSES = ["failed", "final_reply_failed"] as const;
export const MODEL_CALL_LOG_NOTE = "这是应用操作的用量记录，部分操作合并了重试，不等同于逐次供应商或 API Key 调用日志；未记录 Key 指纹。状态仅来自已知 metadata，不能由 token 推断成功，也不代表渠道发送成功；no_sources/context_answered 表示操作完成，不保证实际调用了供应商。零 token 表示没有报告用量，不代表免费。金额仅逐条估算，按记录时间和缓存明细取价；缺缓存明细按未命中估算，可能偏高；未知模型或缺用量的金额为空。筛选选项取所选日期内最多 200 个不同值。";
export type ModelCallLogQuery = { days: 1 | 7 | 30; kind?: string; model?: string; page: number; pageSize: 20 | 50 };

export function parseModelCallLogQuery(query: Record<string, unknown>): ModelCallLogQuery {
  function scalar(key: string): string | undefined {
    const value = query[key];
    if (value === undefined) return undefined;
    if (typeof value !== "string") throw createError({ statusCode: 400, statusMessage: `Invalid ${key}.` });
    return value;
  }
  const days = scalar("days") ?? "7";
  const pageSize = scalar("pageSize") ?? "20";
  const page = scalar("page") ?? "1";
  const kind = scalar("kind");
  const model = scalar("model");
  if (!["1", "7", "30"].includes(days) || !["20", "50"].includes(pageSize)
    || !/^[1-9]\d*$/.test(page) || !Number.isSafeInteger(Number(page))
    || !Number.isSafeInteger((Number(page) - 1) * Number(pageSize))
    || (kind !== undefined && !MODEL_CALL_LOG_KINDS.some((value) => value === kind))
    || (model !== undefined && (!model.trim() || model.length > 120))) {
    throw createError({ statusCode: 400, statusMessage: "Invalid model usage log filters." });
  }
  return { days: Number(days) as ModelCallLogQuery["days"], pageSize: Number(pageSize) as 20 | 50, page: Number(page), ...(kind === undefined ? {} : { kind }), ...(model === undefined ? {} : { model }) };
}

export function modelCallLogWhere(characterId: string, query: ModelCallLogQuery, now = new Date()): Prisma.ModelUsageWhereInput {
  const days = usageDayWindow(query.days, now);
  const start = new Date(`${days[0]}T00:00:00+08:00`);
  const end = new Date(new Date(`${days[days.length - 1]}T00:00:00+08:00`).getTime() + 86_400_000);
  return { characterId, createdAt: { gte: start, lt: end }, ...(query.kind === undefined ? {} : { kind: query.kind }), ...(query.model === undefined ? {} : { model: query.model }) };
}

export function modelCallLogStatus(metadata: unknown): "success" | "failed" | "unknown" {
  const status = record(metadata).status;
  if (SUCCESS_STATUSES.some((value) => value === status)) return "success";
  if (FAILED_STATUSES.some((value) => value === status)) return "failed";
  return "unknown";
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function code(value: unknown): string | null {
  // Only short machine codes; never expose arbitrary provider errors, prompts or metadata.
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : null;
}
function integer(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : null;
}
export type ModelCallLogRow = {
  id: string; createdAt: Date; kind: string; model: string; metadata: unknown;
  promptTokens: number; completionTokens: number; totalTokens: number;
  reasoningTokens: number | null; cacheHitTokens: number | null; cacheMissTokens: number | null;
};
export function toModelCallLogItem(row: ModelCallLogRow) {
  const metadata = record(row.metadata);
  const price = resolveModelPrice(row.model);
  const usageReported = row.totalTokens > 0;
  return {
    id: row.id, createdAt: row.createdAt.toISOString(), kind: row.kind, model: row.model,
    status: modelCallLogStatus(metadata), promptTokens: row.promptTokens, completionTokens: row.completionTokens,
    totalTokens: row.totalTokens, reasoningTokens: row.reasoningTokens,
    cacheHitTokens: row.cacheHitTokens, cacheMissTokens: row.cacheMissTokens, usageReported,
    attempts: integer(metadata.attempts, 0, 10_000), durationMs: integer(metadata.durationMs, 0, 3_600_000), finishReason: code(metadata.finishReason),
    httpStatus: integer(metadata.httpStatus, 100, 599), reason: code(metadata.reason),
    costCny: usageReported && price ? estimateUsageCostCny(price, { promptTokens: row.promptTokens, completionTokens: row.completionTokens, ...(row.cacheHitTokens === null ? {} : { cacheHitTokens: row.cacheHitTokens }) }, row.createdAt) : null,
  };
}
function statusWhere(statuses: readonly string[]): Prisma.ModelUsageWhereInput {
  return { OR: statuses.map((status) => ({ metadata: { path: ["status"], equals: status } })) };
}

export async function readModelCallLogs(characterId: string, query: ModelCallLogQuery, prisma = getPrisma(), now = new Date()) {
  const where = modelCallLogWhere(characterId, query, now);
  const facetWhere = modelCallLogWhere(characterId, { ...query, kind: undefined, model: undefined }, now);
  const [rows, aggregate, success, failed, usageMissingRecords, models, kinds] = await Promise.all([
    prisma.modelUsage.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (query.page - 1) * query.pageSize, take: query.pageSize,
      select: { id: true, createdAt: true, kind: true, model: true, metadata: true, promptTokens: true, completionTokens: true, totalTokens: true, reasoningTokens: true, cacheHitTokens: true, cacheMissTokens: true } }),
    prisma.modelUsage.aggregate({ where, _count: { _all: true }, _sum: { totalTokens: true } }),
    prisma.modelUsage.count({ where: { AND: [where, statusWhere(SUCCESS_STATUSES)] } }),
    prisma.modelUsage.count({ where: { AND: [where, statusWhere(FAILED_STATUSES)] } }),
    prisma.modelUsage.count({ where: { AND: [where, { totalTokens: { lte: 0 } }] } }),
    // groupBy + take keeps distinct discovery in the database, rather than Prisma's in-memory distinct.
    prisma.modelUsage.groupBy({ by: ["model"], where: facetWhere, orderBy: { model: "asc" }, take: 200 }),
    prisma.modelUsage.groupBy({ by: ["kind"], where: facetWhere, orderBy: { kind: "asc" }, take: 200 }),
  ]);
  const total = aggregate._count._all;
  return {
    items: rows.map(toModelCallLogItem), page: query.page, pageSize: query.pageSize, total,
    summary: { records: total, totalTokens: aggregate._sum.totalTokens ?? 0, failed, unknown: Math.max(0, total - success - failed), usageMissingRecords },
    models: models.map((row) => row.model), kinds: kinds.map((row) => row.kind), note: MODEL_CALL_LOG_NOTE,
  };
}
