import { sanitizeGrowthReadDiagnostics, type GrowthReadDiagnostic } from "./growth-read-diagnostics";
import { sanitizeAssistantTurnDiagnostics, type AssistantTurnDiagnostics } from "./assistant-turn-diagnostics";

export type TurnEvidence = { id?: string; member?: string; speaker?: string; content: string; occurredAt?: string };
export type TurnSource = { id: string; type: "memory" | "snapshot" | "event" | "message"; scope: "character" | "private"; title?: string; content: string; occurredAt?: string };
/** 本轮某类来源「放进去几条、用掉多少预算、被挤掉几条」。只有数字，没有正文。 */
export type TurnSegmentStats = { count: number; usedTokens: number; dropped: number };
export type TurnRetrievalStats = {
  memory: TurnSegmentStats;
  snapshot: TurnSegmentStats;
  event: TurnSegmentStats & { mode?: "range" | "participant" | "first" | "latest" | "keyword"; recent?: number };
  /** 模型自报引用了几条（已按来源白名单过滤）。与上面的 count 对比，才能分出「没检索到」「被挤掉」「放进去了没用上」。 */
  used?: { memory: number; snapshot: number; event: number };
};
export type TurnPlanSegmentStats = {
  source: "recentMessages" | "memory" | "snapshot" | "event" | "rawMessage" | "crossChannel" | "knowledge";
  budget: number;
  limit: number;
  reason: "always" | "question_has_date" | "question_has_topic" | "keyword_hit" | "owner_cross_channel";
  optional: boolean;
  used: number;
  items: number;
};
/** 这一轮「计划放哪些来源」与真实用量；由 context-plan.ts 生成，本文件只做白名单清洗。 */
export type TurnContextPlanStats = {
  surface: "desktop" | "private" | "group";
  totalBudget: number;
  segments: TurnPlanSegmentStats[];
};
/**
 * 整轮墙钟时间：totalMs 从渠道入口算起，generationMs 只含正式生成阶段，
 * responseMs 是主回复阶段总耗时，modelMs 只含真实模型请求；
 * responseMs - modelMs 是本地处理，totalMs - generationMs 是前置数据库准备。
 * 各项都是同一时间轴上的差值，不做累加，因此不会重复计算。
 */
export type TurnTimingStats = { totalMs: number; generationMs?: number; responseMs?: number; modelMs?: number };
/**
 * 由入口起点与生成起点构造耗时快照。
 *
 * 只做单调时钟差值：前置准备已经包含在 totalMs 里，不另加到 generationMs 上。
 * 生成阶段尚未开始时 generationMs 留空，不能拿总耗时冒充。
 */
export function buildTurnTiming(input: {
  turnStartedAt: number; generationStartedAt?: number; now?: number;
  responseMs?: number; modelMs?: number;
}): TurnTimingStats {
  const now = input.now ?? Date.now();
  const totalMs = Math.max(0, Math.round(now - input.turnStartedAt));
  const generationMs = input.generationStartedAt === undefined
    ? undefined : Math.max(0, Math.round(now - input.generationStartedAt));
  const responseMs = input.responseMs !== undefined && Number.isFinite(input.responseMs) && input.responseMs >= 0
    ? Math.round(input.responseMs) : undefined;
  const modelMs = input.modelMs !== undefined && Number.isFinite(input.modelMs) && input.modelMs >= 0
    ? Math.round(input.modelMs) : undefined;
  return { totalMs, ...(generationMs !== undefined ? { generationMs } : {}),
    ...(responseMs !== undefined ? { responseMs } : {}), ...(modelMs !== undefined ? { modelMs } : {}) };
}
/** 知识检索阶段；未触发写 not_needed/not_enabled，执行了但没结果写 no_sources。 */
export type TurnKnowledgeStats = {
  status: "not_enabled" | "not_needed" | "no_sources" | "success" | "failed";
  query?: string; durationMs?: number; itemCount?: number;
};
/** 关键数据库往返耗时：只记毫秒，不记 SQL、参数或正文。 */
export type TurnDatabaseStats = {
  knowledgeReadMs?: number; memoryCandidateMs?: number; knowledgeCollectMs?: number;
};
export const TURN_FAILURE_REASONS = ["timeout", "http_error", "invalid_response", "empty_reply", "model_error"] as const;
export type TurnFailureReason = typeof TURN_FAILURE_REASONS[number];
export type TurnDetailPatch = {
  collaboration?: unknown;
  growthReads?: unknown;
  retrieval?: unknown;
  contextPlan?: unknown;
  /** 与落盘 metadata.turnId 相同的轮次标识；不另造一套关联键。 */
  traceId?: string;
  timing?: TurnTimingStats;
  knowledge?: TurnKnowledgeStats;
  database?: TurnDatabaseStats;
  context?: { status: "not_enabled" | "not_applicable" | "success" | "failed"; summary?: string; participation?: "invited" | "observing" | "uncertain"; uncertainty?: string; evidence?: TurnEvidence[]; durationMs?: number };
  memory?: { status: "not_needed" | "not_enabled" | "no_sources" | "failed" | "success"; query?: string; candidateCount?: number; sources?: TurnSource[]; durationMs?: number };
  response?: { action: "reply" | "silent"; reply: string; explanation?: string; failureReason?: TurnFailureReason; durationMs?: number; attempts?: number };
};
export type ModelTurnDetail = {
  version: 1; groupChat: boolean; messages: TurnEvidence[];
  channel?: "qq-private" | "web";
  traceId?: string;
  timing?: TurnTimingStats;
  knowledge?: TurnKnowledgeStats;
  database?: TurnDatabaseStats;
  collaboration?: AssistantTurnDiagnostics;
  growthReads?: GrowthReadDiagnostic[];
  retrieval?: TurnRetrievalStats;
  contextPlan?: TurnContextPlanStats;
  context: NonNullable<TurnDetailPatch["context"]>;
  memory: NonNullable<TurnDetailPatch["memory"]>;
  response: { status: "success" | "failed"; action?: "reply" | "silent"; reply?: string; explanation?: string; failureReason?: TurnFailureReason; durationMs?: number; attempts?: number };
};
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
}
function evidence(value: unknown): TurnEvidence[] {
  return (Array.isArray(value) ? value : []).slice(-20).map(item => {
    const row = object(item);
    return { content: text(row.content, 1200) ?? "", id: text(row.id, 120), member: text(row.member, 80), speaker: text(row.speaker, 80), occurredAt: text(row.occurredAt, 40) };
  }).filter(row => row.content);
}
function countOf(value: unknown, max = 100_000): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(0, Math.round(value))) : undefined;
}
/** 三个数字缺一就不记录：宁可没有这一行，也不写出「选了 3 条、挤掉 undefined 条」。 */
function segmentStats(value: unknown): TurnSegmentStats | undefined {
  const row = object(value);
  const count = countOf(row.count), usedTokens = countOf(row.usedTokens), dropped = countOf(row.dropped);
  if (count === undefined || usedTokens === undefined || dropped === undefined) return undefined;
  return { count, usedTokens, dropped };
}
const EVENT_MODES = ["range", "participant", "first", "latest", "keyword"] as const;
function retrievalStats(value: unknown): TurnRetrievalStats | undefined {
  const row = object(value), eventRow = object(row.event);
  const memory = segmentStats(row.memory), snapshot = segmentStats(row.snapshot), event = segmentStats(eventRow);
  if (!memory || !snapshot || !event) return undefined;
  const mode = EVENT_MODES.find(item => item === eventRow.mode);
  // 兼容两种形状：入口传的是选择层原样（recentEvent.count），落盘再读回时是 event.recent。
  const recent = countOf(object(row.recentEvent).count) ?? countOf(eventRow.recent);
  const usedRow = object(row.used);
  const usedMemory = countOf(usedRow.memory), usedSnapshot = countOf(usedRow.snapshot), usedEvent = countOf(usedRow.event);
  const used = usedMemory === undefined || usedSnapshot === undefined || usedEvent === undefined
    ? undefined
    : { memory: usedMemory, snapshot: usedSnapshot, event: usedEvent };
  return { memory, snapshot, event: { ...event, ...(mode ? { mode } : {}), ...(recent === undefined ? {} : { recent }) }, ...(used ? { used } : {}) };
}
const PLAN_SOURCES = ["recentMessages", "memory", "snapshot", "event", "rawMessage", "crossChannel", "knowledge"] as const;
const PLAN_REASONS = ["always", "question_has_date", "question_has_topic", "keyword_hit", "owner_cross_channel"] as const;
function contextPlanStats(value: unknown): TurnContextPlanStats | undefined {
  const row = object(value);
  const surface = (["desktop", "private", "group"] as const).find(item => item === row.surface);
  const totalBudget = countOf(row.totalBudget);
  if (!surface || totalBudget === undefined) return undefined;
  const segments = (Array.isArray(row.segments) ? row.segments : []).slice(0, 12).flatMap(item => {
    const segment = object(item);
    const source = PLAN_SOURCES.find((candidate) => candidate === segment.source);
    const reason = PLAN_REASONS.find((candidate) => candidate === segment.reason);
    const budget = countOf(segment.budget), limit = countOf(segment.limit);
    const used = countOf(segment.used), items = countOf(segment.items);
    if (!source || !reason || budget === undefined || limit === undefined || used === undefined || items === undefined) return [];
    return [{ source, reason, budget, limit, used, items, optional: segment.optional === true }];
  });
  // 一段都留不下就没有意义，整块丢弃，避免出现空计划被当成「什么都没放」。
  if (!segments.length) return undefined;
  return { surface, totalBudget, segments };
}
function ms(value: unknown): number | undefined { return countOf(value, 3_600_000); }
function timingStats(value: unknown): TurnTimingStats | undefined {
  const row = object(value);
  const totalMs = ms(row.totalMs);
  if (totalMs === undefined) return undefined;
  const generationMs = ms(row.generationMs), responseMs = ms(row.responseMs), modelMs = ms(row.modelMs);
  return { totalMs, ...(generationMs !== undefined ? { generationMs } : {}),
    ...(responseMs !== undefined ? { responseMs } : {}), ...(modelMs !== undefined ? { modelMs } : {}) };
}
function knowledgeStats(value: unknown): TurnKnowledgeStats | undefined {
  const row = object(value);
  const status = (["not_enabled", "not_needed", "no_sources", "success", "failed"] as const).find(item => item === row.status);
  if (!status) return undefined;
  const query = text(row.query, 240), durationMs = ms(row.durationMs), itemCount = countOf(row.itemCount, 100_000);
  return { status, ...(query ? { query } : {}), ...(durationMs !== undefined ? { durationMs } : {}), ...(itemCount !== undefined ? { itemCount } : {}) };
}
function databaseStats(value: unknown): TurnDatabaseStats | undefined {
  const row = object(value);
  const result: TurnDatabaseStats = {};
  for (const key of ["knowledgeReadMs", "memoryCandidateMs", "knowledgeCollectMs"] as const) {
    const duration = ms(row[key]);
    if (duration !== undefined) result[key] = duration;
  }
  return Object.keys(result).length ? result : undefined;
}
const TRACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Explicit allowlist: diagnostics are evidence summaries, never serialized prompts/provider reasoning. */
export function sanitizeModelTurnDetail(value: unknown): ModelTurnDetail {
  const raw = object(value), context = object(raw.context), memory = object(raw.memory), response = object(raw.response);
  const groupChat = raw.groupChat === true;
  const collaboration = sanitizeAssistantTurnDiagnostics(raw.collaboration);
  const channel = !groupChat && (raw.channel === "qq-private" || raw.channel === "web") ? raw.channel : undefined;
  const growthReads = groupChat || channel ? sanitizeGrowthReadDiagnostics(raw.growthReads) : undefined;
  const retrieval = retrievalStats(raw.retrieval);
  const contextPlan = contextPlanStats(raw.contextPlan);
  const sources: TurnSource[] = (Array.isArray(memory.sources) ? memory.sources : []).slice(0, 8).flatMap(item => {
    const row = object(item);
    if (!["memory", "snapshot", "event", "message"].includes(String(row.type)) || !["character", "private"].includes(String(row.scope)) || (groupChat && row.scope !== "character")) return [];
    const id = text(row.id, 120), content = text(row.content, 1600);
    if (!id || !content) return [];
    return [{ id, content, type: row.type as TurnSource["type"], scope: row.scope as TurnSource["scope"], title: text(row.title, 160), occurredAt: text(row.occurredAt, 40) }];
  });
  const timing = timingStats(raw.timing), knowledge = knowledgeStats(raw.knowledge), database = databaseStats(raw.database);
  const traceId = typeof raw.traceId === "string" && TRACE_ID.test(raw.traceId) ? raw.traceId : undefined;
  const contextMs = ms(context.durationMs), memoryMs = ms(memory.durationMs), responseMs = ms(response.durationMs);
  const failureReason = TURN_FAILURE_REASONS.find(item => item === response.failureReason);
  const attempts = countOf(response.attempts, 64);
  return {
    version: 1, groupChat, messages: evidence(raw.messages),
    ...(channel ? { channel } : {}),
    ...(traceId ? { traceId } : {}),
    ...(timing ? { timing } : {}),
    ...(knowledge ? { knowledge } : {}),
    ...(database ? { database } : {}),
    ...(collaboration ? { collaboration } : {}),
    ...(growthReads ? { growthReads } : {}),
    ...(retrieval ? { retrieval } : {}),
    ...(contextPlan ? { contextPlan } : {}),
    context: {
      status: ["not_enabled", "not_applicable", "success", "failed"].includes(String(context.status)) ? context.status as ModelTurnDetail["context"]["status"] : "not_enabled",
      summary: text(context.summary, 1600), uncertainty: text(context.uncertainty, 400),
      participation: ["invited", "observing", "uncertain"].includes(String(context.participation)) ? context.participation as ModelTurnDetail["context"]["participation"] : undefined,
      evidence: evidence(context.evidence).slice(0, 12),
      ...(contextMs !== undefined ? { durationMs: contextMs } : {}),
    },
    memory: {
      status: ["not_needed", "not_enabled", "no_sources", "failed", "success"].includes(String(memory.status)) ? memory.status as ModelTurnDetail["memory"]["status"] : "not_needed",
      query: text(memory.query, 240),
      candidateCount: typeof memory.candidateCount === "number" && Number.isFinite(memory.candidateCount)
        ? Math.min(10_000, Math.max(0, Math.round(memory.candidateCount))) : undefined,
      sources,
      ...(memoryMs !== undefined ? { durationMs: memoryMs } : {}),
    },
    response: {
      status: response.status === "success" ? "success" : "failed",
      action: response.action === "reply" || response.action === "silent" ? response.action : undefined,
      reply: text(response.reply, 4000), explanation: text(response.explanation, 400),
      ...(failureReason ? { failureReason } : {}),
      ...(responseMs !== undefined ? { durationMs: responseMs } : {}),
      ...(attempts !== undefined ? { attempts } : {}),
    },
  };
}
export function createModelTurnDetail(groupChat: boolean, messages: TurnEvidence[], channel?: ModelTurnDetail["channel"], traceId?: string) {
  const detail: ModelTurnDetail = { version: 1, groupChat, messages, channel: groupChat ? undefined : channel,
    ...(traceId && TRACE_ID.test(traceId) ? { traceId } : {}),
    context: { status: groupChat ? "not_enabled" : "not_applicable" }, memory: { status: "not_needed" }, response: { status: "failed" } };
  return {
    update(patch: TurnDetailPatch) {
      if (patch.traceId && TRACE_ID.test(patch.traceId)) detail.traceId = patch.traceId;
      if (patch.timing !== undefined) { const stats = timingStats(patch.timing); if (stats) detail.timing = stats; }
      if (patch.knowledge !== undefined) { const stats = knowledgeStats(patch.knowledge); if (stats) detail.knowledge = stats; }
      if (patch.database !== undefined) { const stats = databaseStats(patch.database); if (stats) detail.database = stats; }
      if (patch.growthReads !== undefined && (groupChat || detail.channel === "qq-private" || detail.channel === "web")) detail.growthReads = sanitizeGrowthReadDiagnostics(patch.growthReads);
      if (patch.collaboration !== undefined) detail.collaboration = sanitizeAssistantTurnDiagnostics(patch.collaboration);
      if (patch.context) detail.context = patch.context;
      if (patch.memory) detail.memory = patch.memory;
      if (patch.retrieval !== undefined) {
        const stats = retrievalStats(patch.retrieval);
        if (stats) detail.retrieval = stats;
      }
      if (patch.contextPlan !== undefined) {
        const plan = contextPlanStats(patch.contextPlan);
        if (plan) detail.contextPlan = plan;
      }
      // 带失败原因的 patch 不能再把状态覆盖成 success：模型失败那一路必须留下 failed。
      if (patch.response) detail.response = { status: patch.response.failureReason ? "failed" : "success", ...patch.response };
    },
    serialize() {
      const safe = sanitizeModelTurnDetail(detail);
      // JSON escaping can expand control characters; enforce the stored size as well as field limits.
      let serialized = JSON.stringify(safe);
      while (serialized.length > 80_000) {
        if (safe.messages.length > 1) safe.messages.shift();
        else if (safe.context.evidence?.length) safe.context.evidence.pop();
        else if (safe.memory.sources?.length) safe.memory.sources.pop();
        else {
          safe.response.reply = safe.response.reply?.slice(0, 1000);
          safe.context.summary = safe.context.summary?.slice(0, 400);
          break;
        }
        serialized = JSON.stringify(safe);
      }
      return JSON.stringify(safe);
    },
  };
}
export function readModelTurnDetail(value: unknown): ModelTurnDetail | null {
  if (typeof value !== "string" || value.length > 80_000) return null;
  try { const parsed: unknown = JSON.parse(value); return object(parsed).version === 1 ? sanitizeModelTurnDetail(parsed) : null; } catch { return null; }
}
export function readModelTurnId(metadata: unknown): string | null {
  const value = object(metadata).turnId;
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value : null;
}
