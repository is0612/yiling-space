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
export type TurnDetailPatch = {
  collaboration?: unknown;
  growthReads?: unknown;
  retrieval?: unknown;
  contextPlan?: unknown;
  context?: { status: "not_enabled" | "not_applicable" | "success" | "failed"; summary?: string; participation?: "invited" | "observing" | "uncertain"; uncertainty?: string; evidence?: TurnEvidence[] };
  memory?: { status: "not_needed" | "not_enabled" | "no_sources" | "failed" | "success"; query?: string; candidateCount?: number; sources?: TurnSource[] };
  response?: { action: "reply" | "silent"; reply: string; explanation?: string };
};
export type ModelTurnDetail = {
  version: 1; groupChat: boolean; messages: TurnEvidence[];
  channel?: "qq-private" | "web";
  collaboration?: AssistantTurnDiagnostics;
  growthReads?: GrowthReadDiagnostic[];
  retrieval?: TurnRetrievalStats;
  contextPlan?: TurnContextPlanStats;
  context: NonNullable<TurnDetailPatch["context"]>;
  memory: NonNullable<TurnDetailPatch["memory"]>;
  response: { status: "success" | "failed"; action?: "reply" | "silent"; reply?: string; explanation?: string };
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
  return {
    version: 1, groupChat, messages: evidence(raw.messages),
    ...(channel ? { channel } : {}),
    ...(collaboration ? { collaboration } : {}),
    ...(growthReads ? { growthReads } : {}),
    ...(retrieval ? { retrieval } : {}),
    ...(contextPlan ? { contextPlan } : {}),
    context: {
      status: ["not_enabled", "not_applicable", "success", "failed"].includes(String(context.status)) ? context.status as ModelTurnDetail["context"]["status"] : "not_enabled",
      summary: text(context.summary, 1600), uncertainty: text(context.uncertainty, 400),
      participation: ["invited", "observing", "uncertain"].includes(String(context.participation)) ? context.participation as ModelTurnDetail["context"]["participation"] : undefined,
      evidence: evidence(context.evidence).slice(0, 12),
    },
    memory: {
      status: ["not_needed", "not_enabled", "no_sources", "failed", "success"].includes(String(memory.status)) ? memory.status as ModelTurnDetail["memory"]["status"] : "not_needed",
      query: text(memory.query, 240),
      candidateCount: typeof memory.candidateCount === "number" && Number.isFinite(memory.candidateCount)
        ? Math.min(10_000, Math.max(0, Math.round(memory.candidateCount))) : undefined,
      sources,
    },
    response: {
      status: response.status === "success" ? "success" : "failed",
      action: response.action === "reply" || response.action === "silent" ? response.action : undefined,
      reply: text(response.reply, 4000), explanation: text(response.explanation, 400),
    },
  };
}
export function createModelTurnDetail(groupChat: boolean, messages: TurnEvidence[], channel?: ModelTurnDetail["channel"]) {
  const detail: ModelTurnDetail = { version: 1, groupChat, messages, channel: groupChat ? undefined : channel, context: { status: groupChat ? "not_enabled" : "not_applicable" }, memory: { status: "not_needed" }, response: { status: "failed" } };
  return {
    update(patch: TurnDetailPatch) {
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
      if (patch.response) detail.response = { status: "success", ...patch.response };
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
