import { createHash } from "node:crypto";
import { createError } from "h3";
import { parsePreferenceSources, PREFERENCE_UUID, type PreferenceSourceRef } from "./preferences-domain";
export const GOAL_KINDS = ["GOAL", "WISH"] as const;
export const GOAL_STATUSES = ["PENDING", "ACTIVE", "PAUSED", "COMPLETED", "ABANDONED", "REJECTED"] as const;
export type GoalKind = typeof GOAL_KINDS[number];
export type GoalStatus = typeof GOAL_STATUSES[number];
function bad(message: string): never { throw createError({ statusCode: 400, statusMessage: message }); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) bad("目标请求无效。");
  return value as Record<string, unknown>;
}
function fields(body: Record<string, unknown>, allowed: string[]) { if (Object.keys(body).some(key => !allowed.includes(key))) bad("目标请求包含不允许的字段。"); }
function text(value: unknown, max: number, label: string) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) bad(`${label}不能为空，且最多${max}字。`);
  return value.trim();
}
function kind(value: unknown): GoalKind { if (!GOAL_KINDS.includes(value as GoalKind)) bad("目标类型无效。"); return value as GoalKind; }
function revision(value: unknown) { if (!Number.isSafeInteger(value) || (value as number) < 1) bad("请提供有效的expectedRevision。"); return value as number; }
export function parseGoalSources(value: unknown): PreferenceSourceRef[] {
  try { return parsePreferenceSources(value); } catch { bad("请选择1至5条有效且不重复的公开目标来源。"); }
}
export function parseGoalCreate(value: unknown) {
  const body = record(value); fields(body, ["kind", "title", "description", "reason", "status", "sources"]);
  const sources = body.sources === undefined ? [] : parseGoalSources(body.sources); const status = body.status ?? "PENDING";
  if (status !== "PENDING" && status !== "ACTIVE") bad("新目标仅可待确认或进行中。");
  if (sources.length && status !== "PENDING") bad("来源目标必须先成为待确认候选。");
  return { kind: kind(body.kind), title: text(body.title, 100, "目标标题"), description: text(body.description, 1000, "目标描述"), reason: text(body.reason, 1000, "形成原因"), status, sources } as const;
}
export function parseGoalPatch(value: unknown) {
  const body = record(value); fields(body, ["expectedRevision", "operation", "kind", "title", "description", "reason"]);
  const operation = body.operation;
  if (operation !== "EDIT" && operation !== "ACTIVATE" && operation !== "PAUSE" && operation !== "COMPLETE" && operation !== "ABANDON" && operation !== "REJECT") bad("目标操作无效。");
  const editable = ["kind", "title", "description", "reason"];
  if (operation !== "EDIT" && editable.some(key => body[key] !== undefined)) bad("状态操作不能同时编辑内容。");
  if (operation === "EDIT" && editable.every(key => body[key] === undefined)) bad("请提供需要修改的目标内容。");
  return { expectedRevision: revision(body.expectedRevision), operation,
    ...(body.kind !== undefined ? { kind: kind(body.kind) } : {}),
    ...(body.title !== undefined ? { title: text(body.title, 100, "目标标题") } : {}),
    ...(body.description !== undefined ? { description: text(body.description, 1000, "目标描述") } : {}),
    ...(body.reason !== undefined ? { reason: text(body.reason, 1000, "形成原因") } : {}) };
}
export function goalNextStatus(status: string, operation: string): GoalStatus {
  if (operation === "EDIT" && ["PENDING", "ACTIVE", "PAUSED"].includes(status)) return status as GoalStatus;
  if (operation === "ACTIVATE" && ["PENDING", "PAUSED"].includes(status)) return "ACTIVE";
  if (operation === "PAUSE" && status === "ACTIVE") return "PAUSED";
  if ((operation === "COMPLETE" || operation === "ABANDON") && ["ACTIVE", "PAUSED"].includes(status)) return operation === "COMPLETE" ? "COMPLETED" : "ABANDONED";
  if (operation === "REJECT" && status === "PENDING") return "REJECTED";
  throw createError({ statusCode: 409, statusMessage: "当前目标状态不支持此操作，请刷新。" });
}
export function parseGoalProgress(value: unknown) {
  const body = record(value); fields(body, ["expectedRevision", "requestKey", "content", "sources"]);
  if (typeof body.requestKey !== "string" || !PREFERENCE_UUID.test(body.requestKey)) bad("请提供有效进展请求编号。");
  const sources = body.sources === undefined || (Array.isArray(body.sources) && body.sources.length === 0) ? [] : parseGoalSources(body.sources);
  return { expectedRevision: revision(body.expectedRevision), requestKey: body.requestKey.toLowerCase(), content: text(body.content, 1000, "进展内容"), sources };
}
export function goalProgressPayloadHash(input: { content: string; sources: PreferenceSourceRef[] }) {
  const refs = [...input.sources].sort((a, b) => `${a.type}:${a.id}`.localeCompare(`${b.type}:${b.id}`));
  // expectedRevision is transport concurrency metadata, not part of the user's append operation.
  return createHash("sha256").update(JSON.stringify([input.content, refs])).digest("hex");
}
export function parseGoalListQuery(query: Record<string, unknown>) {
  const positive = (value: unknown, fallback: number, max: number) => { if (value === undefined) return fallback;
    if (typeof value !== "string" || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > max) bad("分页参数无效。"); return Number(value); };
  const status = query.status ?? "ALL";
  if (status !== "ALL" && !GOAL_STATUSES.includes(status as GoalStatus)) bad("目标状态筛选无效。");
  if (query.q !== undefined && (typeof query.q !== "string" || query.q.length > 100)) bad("搜索词最多100字。");
  return { page: positive(query.page, 1, 10000), pageSize: positive(query.pageSize, 20, 50), status: status as GoalStatus | "ALL", q: typeof query.q === "string" ? query.q.trim() : "" };
}
export function goalPage<T>(items: T[], total: number, page: number, pageSize: number) { return { items, pagination: { page, pageSize, total, pageCount: Math.max(1, Math.ceil(total / pageSize)) } }; }
