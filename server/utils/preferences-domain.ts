import { createHash } from "node:crypto";
import { createError } from "h3";

export const PREFERENCE_KINDS = ["LIKE", "DISLIKE", "INTEREST"] as const;
export const PREFERENCE_STATUSES = ["PENDING", "ACTIVE", "REJECTED", "DISABLED"] as const;
export type PreferenceKind = typeof PREFERENCE_KINDS[number];
export type PreferenceStatus = typeof PREFERENCE_STATUSES[number];
export type PreferenceSourceRef = { type: "MEMORY_EVENT" | "REFLECTION_SUGGESTION"; id: string; hash: string };
export type PreferenceSourceSnapshot = PreferenceSourceRef & { title: string; summary: string };
export const PREFERENCE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function bad(message: string): never { throw createError({ statusCode: 400, statusMessage: message }); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) bad("偏好请求无效。");
  return value as Record<string, unknown>;
}
function fields(body: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(body).some(key => !allowed.includes(key))) bad("偏好请求包含不允许的字段。");
}
function text(value: unknown, max: number, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) bad(`${label}不能为空，且最多${max}字。`);
  return value.trim();
}
function kind(value: unknown): PreferenceKind {
  if (!PREFERENCE_KINDS.includes(value as PreferenceKind)) bad("偏好类型无效。");
  return value as PreferenceKind;
}
export function parsePreferenceSources(value: unknown): PreferenceSourceRef[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 5) bad("请选择1至5条公开来源。");
  const result = value.map(item => {
    const row = record(item); fields(row, ["type", "id", "hash"]);
    if (!["MEMORY_EVENT", "REFLECTION_SUGGESTION"].includes(String(row.type)) || typeof row.id !== "string" || !PREFERENCE_UUID.test(row.id) || typeof row.hash !== "string" || !/^[a-f0-9]{64}$/.test(row.hash)) bad("偏好来源引用无效，请重新选择。");
    return { type: row.type as PreferenceSourceRef["type"], id: row.id.toLowerCase(), hash: row.hash };
  });
  if (new Set(result.map(row => `${row.type}:${row.id}`)).size !== result.length) bad("偏好来源不能重复。");
  return result;
}
export function preferenceSourceHash(type: PreferenceSourceRef["type"], id: string, title: string, content: string, extra: unknown = null): string {
  return createHash("sha256").update(JSON.stringify([type, id, title, content, extra])).digest("hex");
}
export function parsePreferenceCreate(value: unknown) {
  const body = record(value); fields(body, ["kind", "topic", "reason", "status", "sources"]);
  const sources = body.sources === undefined ? [] : parsePreferenceSources(body.sources);
  const status = body.status ?? "PENDING";
  if (status !== "PENDING" && status !== "ACTIVE") bad("新偏好仅可为待确认或生效。");
  if (sources.length && status !== "PENDING") bad("来源偏好必须先成为待确认候选。");
  return { kind: kind(body.kind), topic: text(body.topic, 100, "偏好主题"), reason: text(body.reason, 1000, "偏好原因"), status, sources } as const;
}
export function parsePreferencePatch(value: unknown) {
  const body = record(value); fields(body, ["expectedRevision", "operation", "kind", "topic", "reason"]);
  if (!Number.isSafeInteger(body.expectedRevision) || (body.expectedRevision as number) < 1) bad("请提供有效的expectedRevision。");
  const operation = body.operation;
  if (operation !== "EDIT" && operation !== "ACTIVATE" && operation !== "REJECT" && operation !== "DISABLE") bad("偏好操作无效。");
  if (operation !== "EDIT" && ["kind", "topic", "reason"].some(key => body[key] !== undefined)) bad("状态变更不能同时编辑内容。");
  if (operation === "EDIT" && ["kind", "topic", "reason"].every(key => body[key] === undefined)) bad("请提供需要修改的内容。");
  return { expectedRevision: body.expectedRevision as number, operation,
    ...(body.kind !== undefined ? { kind: kind(body.kind) } : {}),
    ...(body.topic !== undefined ? { topic: text(body.topic, 100, "偏好主题") } : {}),
    ...(body.reason !== undefined ? { reason: text(body.reason, 1000, "偏好原因") } : {}),
  };
}
export function preferenceNextStatus(status: string, operation: string): PreferenceStatus {
  if (operation === "EDIT" && PREFERENCE_STATUSES.includes(status as PreferenceStatus)) return status as PreferenceStatus;
  if (operation === "ACTIVATE" && (status === "PENDING" || status === "DISABLED")) return "ACTIVE";
  if (operation === "REJECT" && status === "PENDING") return "REJECTED";
  if (operation === "DISABLE" && status === "ACTIVE") return "DISABLED";
  throw createError({ statusCode: 409, statusMessage: "当前偏好状态不支持此操作，请刷新。" });
}
export function parsePreferenceListQuery(query: Record<string, unknown>) {
  const positive = (value: unknown, fallback: number, max: number) => {
    if (value === undefined) return fallback;
    if (typeof value !== "string" || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > max) bad("分页参数无效。");
    return Number(value);
  };
  const page = positive(query.page, 1, 10000); const pageSize = positive(query.pageSize, 20, 50);
  const status = query.status ?? "ALL";
  if (status !== "ALL" && !PREFERENCE_STATUSES.includes(status as PreferenceStatus)) bad("偏好状态筛选无效。");
  if (query.q !== undefined && (typeof query.q !== "string" || query.q.length > 100)) bad("搜索词最多100字。");
  return { page, pageSize, status: status as PreferenceStatus | "ALL", q: typeof query.q === "string" ? query.q.trim() : "" };
}
export function preferencePage<T>(items: T[], total: number, page: number, pageSize: number) {
  return { items, pagination: { page, pageSize, total, pageCount: Math.max(1, Math.ceil(total / pageSize)) } };
}
