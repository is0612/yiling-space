import { createError } from "h3";
import type { Prisma, PrismaClient, CharacterInteractionGuidance } from "../../src/generated/prisma/client";
import { validateEducationTransferSources } from "./education-transfer";
import { assertPreferenceOwner, lockPreferenceOwner } from "./preferences-sources";
import { preferenceQueryTerms } from "./preference-retrieval";
import { parsePreferenceListQuery, preferencePage } from "./preferences-domain";

export const GUIDANCE_KINDS = ["UNDERSTANDING", "REFERENCE", "SITUATION", "STRATEGY"] as const;
export const GUIDANCE_REASON = "来自已授权教育反馈的抽象互动指导；由主人核对后采纳，不携带私人原文。";
export type GuidanceKind = typeof GUIDANCE_KINDS[number];
type Owner = { ownerId: string; characterId: string };
type ChatScope = "ALL" | "GROUP" | "PRIVATE";
const bad = (message: string): never => { throw createError({ statusCode: 400, statusMessage: message }); };
function text(value: unknown, label: string, empty = false): string {
  if (typeof value !== "string" || (!empty && !value.trim()) || value.trim().length > 400) bad(`${label}最多400字${empty ? "" : "且不能为空"}。`);
  return (value as string).trim();
}
function kind(value: unknown): GuidanceKind {
  if (!(GUIDANCE_KINDS as readonly unknown[]).includes(value)) bad("互动指导类型无效。");
  return value as GuidanceKind;
}
function scope(value: unknown): ChatScope {
  if (!["ALL", "GROUP", "PRIVATE"].includes(String(value))) bad("互动指导聊天范围无效。");
  return value as ChatScope;
}
export const parseInteractionGuidanceListQuery = parsePreferenceListQuery;
export function parseInteractionGuidancePatch(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) bad("互动指导请求无效。");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !["expectedRevision", "operation", "kind", "content", "context", "chatScope"].includes(key))) bad("互动指导包含不允许的字段。");
  if (!Number.isSafeInteger(row.expectedRevision) || Number(row.expectedRevision) < 1) bad("请提供有效版本。");
  if (!["EDIT", "ACTIVATE", "REJECT", "DISABLE"].includes(String(row.operation))) bad("互动指导操作无效。");
  const edits = ["kind", "content", "context", "chatScope"];
  if (row.operation !== "EDIT" && edits.some(key => row[key] !== undefined)) bad("状态变更不能同时编辑。");
  if (row.operation === "EDIT" && edits.every(key => row[key] === undefined)) bad("请提供编辑内容。");
  return { expectedRevision: Number(row.expectedRevision), operation: row.operation as "EDIT" | "ACTIVATE" | "REJECT" | "DISABLE",
    ...(row.kind !== undefined ? { kind: kind(row.kind) } : {}), ...(row.content !== undefined ? { content: text(row.content, "指导") } : {}),
    ...(row.context !== undefined ? { context: text(row.context, "场景") } : {}), ...(row.chatScope !== undefined ? { chatScope: scope(row.chatScope) } : {}) };
}
export function interactionGuidanceNextStatus(status: string, operation: string): string {
  if (operation === "EDIT" && ["PENDING", "ACTIVE", "DISABLED", "REJECTED"].includes(status)) return status;
  if (operation === "ACTIVATE" && ["PENDING", "DISABLED"].includes(status)) return "ACTIVE";
  if (operation === "REJECT" && status === "PENDING") return "REJECTED";
  if (operation === "DISABLE" && status === "ACTIVE") return "DISABLED";
  throw createError({ statusCode: 409, statusMessage: "当前互动指导不支持此操作。" });
}
async function snapshot(tx: Prisma.TransactionClient, row: CharacterInteractionGuidance, actorId: string, action: string) {
  await tx.characterInteractionGuidanceRevision.create({ data: { guidanceId: row.id, revision: row.revision, action, kind: row.kind, content: row.content, context: row.context, chatScope: row.chatScope, status: row.status, sourceRefs: row.sourceRefs as Prisma.InputJsonValue, reason: row.reason, actorId } });
  await tx.auditLog.create({ data: { actorType: action === "CREATE" ? "SYSTEM" : "USER", actorId, characterId: row.characterId, action: `interaction_guidance.${action.toLowerCase()}`, entityType: "CharacterInteractionGuidance", entityId: row.id, details: { revision: row.revision, kind: row.kind, status: row.status } } });
}
/** Domain boundary: the background proposer can create a candidate, never activate it. */
export async function createInteractionGuidanceCandidate(tx: Prisma.TransactionClient, input: { characterId: string; kind: GuidanceKind; content: string; context: string; chatScope: ChatScope; sourceRefs: Prisma.InputJsonValue; actorId: string }) {
  if (!Array.isArray(input.sourceRefs) || input.sourceRefs.length < 1 || input.sourceRefs.length > 30) bad("互动指导缺少有效来源。");
  const guidance = await tx.characterInteractionGuidance.create({ data: { characterId: input.characterId, kind: kind(input.kind), content: text(input.content, "指导"), context: text(input.context, "场景"), chatScope: scope(input.chatScope), status: "PENDING", revision: 1, sourceRefs: input.sourceRefs, reason: GUIDANCE_REASON } });
  await snapshot(tx, guidance, input.actorId, "CREATE");
  return guidance;
}
export async function listInteractionGuidance(prisma: PrismaClient, input: Owner & { status: string; q: string; page: number; pageSize: number }) {
  await assertPreferenceOwner(prisma, input.ownerId, input.characterId);
  const where: Prisma.CharacterInteractionGuidanceWhereInput = { characterId: input.characterId, ...(input.status !== "ALL" ? { status: input.status } : {}), ...(input.q ? { OR: [{ content: { contains: input.q, mode: "insensitive" } }, { context: { contains: input.q, mode: "insensitive" } }] } : {}) };
  const [items, total] = await Promise.all([prisma.characterInteractionGuidance.findMany({ where, orderBy: [{ updatedAt: "desc" }, { id: "desc" }], skip: (input.page - 1) * input.pageSize, take: input.pageSize }), prisma.characterInteractionGuidance.count({ where })]);
  return preferencePage(items, total, input.page, input.pageSize);
}
export async function updateInteractionGuidance(prisma: PrismaClient, input: Owner & { guidanceId: string; body: unknown }) {
  const parsed = parseInteractionGuidancePatch(input.body);
  return prisma.$transaction(async tx => {
    await lockPreferenceOwner(tx, input.ownerId, input.characterId);
    const current = await tx.characterInteractionGuidance.findFirst({ where: { id: input.guidanceId, characterId: input.characterId } });
    if (!current) throw createError({ statusCode: 404, statusMessage: "互动指导不存在。" });
    if (current.revision !== parsed.expectedRevision) throw createError({ statusCode: 409, statusMessage: "互动指导已变化，请刷新。" });
    const status = interactionGuidanceNextStatus(current.status, parsed.operation);
    if (parsed.operation === "ACTIVATE" && current.status === "PENDING" && !await validateEducationTransferSources(tx, input.characterId, current.sourceRefs, GUIDANCE_KINDS)) throw createError({ statusCode: 409, statusMessage: "教育来源或授权已变化，请重新核对候选。" });
    const next = { kind: parsed.kind ?? current.kind, content: parsed.content ?? current.content, context: parsed.context ?? current.context, chatScope: parsed.chatScope ?? current.chatScope };
    if (parsed.operation === "EDIT" && Object.entries(next).every(([key, value]) => current[key as keyof typeof current] === value)) return { guidance: current };
    const changed = await tx.characterInteractionGuidance.updateMany({ where: { id: current.id, characterId: input.characterId, revision: parsed.expectedRevision, status: current.status }, data: { ...next, status, revision: { increment: 1 } } });
    if (changed.count !== 1) throw createError({ statusCode: 409, statusMessage: "互动指导刚刚发生变化。" });
    const guidance = await tx.characterInteractionGuidance.findUniqueOrThrow({ where: { id: current.id } });
    await snapshot(tx, guidance, input.ownerId, parsed.operation);
    return { guidance };
  });
}
export async function listInteractionGuidanceHistory(prisma: PrismaClient, input: Owner & { guidanceId: string; page: number; pageSize: number }) {
  await assertPreferenceOwner(prisma, input.ownerId, input.characterId);
  if (!await prisma.characterInteractionGuidance.findFirst({ where: { id: input.guidanceId, characterId: input.characterId }, select: { id: true } })) throw createError({ statusCode: 404, statusMessage: "互动指导不存在。" });
  const where = { guidanceId: input.guidanceId, guidance: { characterId: input.characterId, character: { ownerId: input.ownerId } } };
  const [items, total] = await Promise.all([prisma.characterInteractionGuidanceRevision.findMany({ where, orderBy: { revision: "desc" }, skip: (input.page - 1) * input.pageSize, take: input.pageSize }), prisma.characterInteractionGuidanceRevision.count({ where })]);
  return preferencePage(items, total, input.page, input.pageSize);
}
export type InteractionGuidanceForPrompt = { id: string; content: string; context: string; weight: number };
export function selectInteractionGuidance(query: string, rows: readonly { id: string; content: string; context: string; status: string; chatScope: string }[], chatScene?: "GROUP" | "PRIVATE", budget = 1200): InteractionGuidanceForPrompt[] {
  const terms = preferenceQueryTerms(query);
  const eligible = rows.filter(row => row.status === "ACTIVE" && (row.chatScope === "ALL" || row.chatScope === chatScene)).map(row => ({ row, score: row.context ? terms.filter(term => row.context.toLowerCase().includes(term)).length : 0 })).filter(({ row, score }) => !row.context || score > 0).sort((a, b) => b.score - a.score || a.row.id.localeCompare(b.row.id));
  const selected: InteractionGuidanceForPrompt[] = []; let used = 0;
  for (const { row } of eligible) {
    const item = { id: row.id, content: row.content, context: row.context, weight: 1 };
    const cost = JSON.stringify(item).length;
    if (selected.length >= 3) break;
    if (used + cost > Math.max(0, Math.min(1200, budget))) continue;
    selected.push(item); used += cost;
  }
  return selected;
}
/** Chat entry resolves the trusted character and scene; private provenance never leaves this reader. */
export async function readInteractionGuidance(prisma: PrismaClient, input: { characterId: string; query: string; chatScene?: "GROUP" | "PRIVATE"; budget?: number }): Promise<InteractionGuidanceForPrompt[]> {
  const terms = preferenceQueryTerms(input.query);
  const rows = await prisma.characterInteractionGuidance.findMany({ where: { characterId: input.characterId, status: "ACTIVE", chatScope: { in: input.chatScene ? ["ALL", input.chatScene] : ["ALL"] }, OR: [{ context: "" }, ...terms.map(term => ({ context: { contains: term, mode: "insensitive" as const } }))] }, orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: 100, select: { id: true, content: true, context: true, status: true, chatScope: true } });
  return selectInteractionGuidance(input.query, rows, input.chatScene, input.budget);
}
