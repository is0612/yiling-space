import { createError } from "h3";
import { parsePreferenceSources, type PreferenceSourceRef } from "./preferences-domain";
// 枚举与前端共用一份（`shared/types/growth.ts`）。服务端保留 Expression* 命名，
// 前端用 Language*：同一集合，别名 re-export，不再各自维护字面量。
import {
  EXPRESSION_CHAT_SCOPES, LANGUAGE_KINDS, LANGUAGE_STATUSES,
  type ChatScope, type LanguageKind, type LanguageStatus,
} from "../../shared/types/growth";
export type ExpressionChatScope = ChatScope;
/** 不导出 EXPRESSION_CHAT_SCOPES：同名 re-export 会与 shared 的自动导入撞车。 */
export function parseExpressionChatScope(value: unknown): ExpressionChatScope {
  if (!(EXPRESSION_CHAT_SCOPES as readonly unknown[]).includes(value)) throw createError({ statusCode: 400, statusMessage: "聊天范围无效。" });
  return value as ExpressionChatScope;
}
export const EXPRESSION_HABIT_KINDS = LANGUAGE_KINDS;
export const EXPRESSION_HABIT_STATUSES = LANGUAGE_STATUSES;
export type ExpressionHabitKind = LanguageKind;
export type ExpressionHabitStatus = LanguageStatus;
function bad(message: string): never { throw createError({ statusCode: 400, statusMessage: message }); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) bad("表达习惯请求无效。");
  return value as Record<string, unknown>;
}
function fields(body: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(body).some(key => !allowed.includes(key))) bad("表达习惯请求包含不允许的字段。");
}
function text(value: unknown, max: number, label: string, empty = false): string {
  if (typeof value !== "string" || (!empty && !value.trim()) || value.trim().length > max) bad(`${label}${empty ? "" : "不能为空，且"}最多${max}字。`);
  return value.trim();
}
function kind(value: unknown): ExpressionHabitKind {
  if (!EXPRESSION_HABIT_KINDS.includes(value as ExpressionHabitKind)) bad("表达习惯类型无效。");
  return value as ExpressionHabitKind;
}
export function parseExpressionHabitSources(value: unknown): PreferenceSourceRef[] {
  try { return parsePreferenceSources(value); }
  catch { bad("请选择1至5条有效且不重复的公开表达习惯来源。"); }
}
export function parseExpressionHabitCreate(value: unknown) {
  const body = record(value); fields(body, ["kind", "content", "context", "chatScope", "reason", "status", "sources"]);
  const sources = body.sources === undefined ? [] : parseExpressionHabitSources(body.sources);
  const status = body.status ?? "PENDING";
  if (status !== "PENDING" && status !== "ACTIVE") bad("新表达习惯仅可为待确认或生效。");
  if (sources.length && status !== "PENDING") bad("来源表达习惯必须先成为待确认候选。");
  return { chatScope: body.chatScope === undefined ? "ALL" as const : parseExpressionChatScope(body.chatScope), kind: kind(body.kind), content: text(body.content, 300, "表达习惯"), context: text(body.context ?? "", 200, "适用场景", true), reason: text(body.reason, 1000, "形成原因"), status, sources } as const;
}
export function parseExpressionHabitPatch(value: unknown) {
  const body = record(value); fields(body, ["expectedRevision", "operation", "kind", "content", "context", "chatScope", "reason"]);
  if (!Number.isSafeInteger(body.expectedRevision) || (body.expectedRevision as number) < 1) bad("请提供有效的expectedRevision。");
  const operation = body.operation;
  if (operation !== "EDIT" && operation !== "ACTIVATE" && operation !== "REJECT" && operation !== "DISABLE") bad("表达习惯操作无效。");
  const editable = ["kind", "content", "context", "chatScope", "reason"];
  if (operation !== "EDIT" && editable.some(key => body[key] !== undefined)) bad("状态变更不能同时编辑内容。");
  if (operation === "EDIT" && editable.every(key => body[key] === undefined)) bad("请提供需要修改的表达习惯内容。");
  return { expectedRevision: body.expectedRevision as number, operation,
    ...(body.kind !== undefined ? { kind: kind(body.kind) } : {}),
    ...(body.content !== undefined ? { content: text(body.content, 300, "表达习惯") } : {}),
    ...(body.chatScope !== undefined ? { chatScope: parseExpressionChatScope(body.chatScope) } : {}),
    ...(body.context !== undefined ? { context: text(body.context, 200, "适用场景", true) } : {}),
    ...(body.reason !== undefined ? { reason: text(body.reason, 1000, "形成原因") } : {}),
  };
}
export function expressionHabitNextStatus(status: string, operation: string): ExpressionHabitStatus {
  if (operation === "EDIT" && EXPRESSION_HABIT_STATUSES.includes(status as ExpressionHabitStatus)) return status as ExpressionHabitStatus;
  if (operation === "ACTIVATE" && (status === "PENDING" || status === "DISABLED")) return "ACTIVE";
  if (operation === "REJECT" && status === "PENDING") return "REJECTED";
  if (operation === "DISABLE" && status === "ACTIVE") return "DISABLED";
  throw createError({ statusCode: 409, statusMessage: "当前表达习惯状态不支持此操作，请刷新。" });
}
export function parseExpressionHabitListQuery(query: Record<string, unknown>) {
  const positive = (value: unknown, fallback: number, max: number) => {
    if (value === undefined) return fallback;
    if (typeof value !== "string" || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > max) bad("分页参数无效。");
    return Number(value);
  };
  const page = positive(query.page, 1, 10000); const pageSize = positive(query.pageSize, 20, 50);
  const status = query.status ?? "ALL";
  if (status !== "ALL" && !EXPRESSION_HABIT_STATUSES.includes(status as ExpressionHabitStatus)) bad("表达习惯状态筛选无效。");
  if (query.q !== undefined && (typeof query.q !== "string" || query.q.length > 100)) bad("搜索词最多100字。");
  return { page, pageSize, status: status as ExpressionHabitStatus | "ALL", q: typeof query.q === "string" ? query.q.trim() : "" };
}
export function expressionHabitPage<T>(items: T[], total: number, page: number, pageSize: number) {
  return { items, pagination: { page, pageSize, total, pageCount: Math.max(1, Math.ceil(total / pageSize)) } };
}
