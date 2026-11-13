import { createHash } from "node:crypto";
import { createError } from "h3";
import type { PrismaClient } from "../../src/generated/prisma/client";

export type DuplicateEvent = { id: string; memoryScopeId: string; conversationId: string | null; dayKey: string; title: string; detail: string; status: string; sourceMessageId: string | null; sourceMessageIds: string[] };
const normalized = (text: string) => text.normalize("NFKC").toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, "");
export const duplicateSources = (row: DuplicateEvent) => [...new Set([row.sourceMessageId, ...row.sourceMessageIds].filter((id): id is string => Boolean(id)))].sort();
export function duplicateReason(a: DuplicateEvent, b: DuplicateEvent) {
  if (a.id === b.id || a.status !== "ACTIVE" || b.status !== "ACTIVE" || a.memoryScopeId !== b.memoryScopeId || a.conversationId !== b.conversationId || a.dayKey !== b.dayKey) return null;
  if (normalized(a.title) === normalized(b.title) && normalized(a.detail) === normalized(b.detail)) return "EXACT_CONTENT";
  const sources = duplicateSources(a);
  return sources.some(id => duplicateSources(b).includes(id)) ? "SHARED_SOURCE" : null;
}
export function duplicateToken(a: DuplicateEvent, b: DuplicateEvent) {
  return createHash("sha256").update(JSON.stringify([a, b].map(row => ({ id: row.id, memoryScopeId: row.memoryScopeId, conversationId: row.conversationId, dayKey: row.dayKey, title: row.title, detail: row.detail, status: row.status, sourceMessageId: row.sourceMessageId, sourceMessageIds: [...row.sourceMessageIds].sort() })))).digest("hex");
}
export const duplicateSelect = { id: true, memoryScopeId: true, conversationId: true, dayKey: true, title: true, detail: true, status: true, sourceMessageId: true, sourceMessageIds: true } as const;
export function duplicateScope(ownerId: string, characterId: string) {
  return { characterId, character: { is: { ownerId } }, OR: [{ scopeType: "CHARACTER_GLOBAL" as const }, { scopeType: "USER_PRIVATE" as const, userId: ownerId, externalIdentityId: null }, { scopeType: "EXTERNAL_IDENTITY" as const, externalIdentity: { is: { status: "VERIFIED" as const, linkedUserId: ownerId } } }] };
}
export function buildDuplicatePairs(rows: DuplicateEvent[]) {
  const pairs = [];
  for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
    const a = rows[i]!, b = rows[j]!;
    const reason = duplicateReason(a, b);
    if (!reason) continue;
    const [keep, candidate] = a.detail.length >= b.detail.length ? [a, b] : [b, a];
    const view = (row: DuplicateEvent) => ({ id: row.id, title: row.title, detail: row.detail, sourceMessageIds: duplicateSources(row) });
    pairs.push({ keep: view(keep), candidate: view(candidate), reason, token: duplicateToken(keep, candidate) });
    if (pairs.length === 100) return { pairs, pairsLimited: true };
  }
  return { pairs, pairsLimited: false };
}
export async function archiveDuplicate(prisma: PrismaClient, input: { ownerId: string; characterId: string; keepId: string; candidateId: string; token: string }) {
  return prisma.$transaction(async tx => {
    const ids = [input.keepId, input.candidateId].sort();
    for (const id of ids) await tx.$queryRaw`SELECT id FROM memory_events WHERE id = ${id}::uuid FOR UPDATE`;
    const rows = await tx.memoryEvent.findMany({ where: { id: { in: ids }, memoryScope: { is: duplicateScope(input.ownerId, input.characterId) } }, select: duplicateSelect });
    const keep = rows.find(row => row.id === input.keepId), candidate = rows.find(row => row.id === input.candidateId);
    if (!keep || !candidate) throw createError({ statusCode: 404, statusMessage: "忆泡不存在或不可修改。" });
    const reason = duplicateReason(keep, candidate);
    if (!reason || duplicateToken(keep, candidate) !== input.token) throw createError({ statusCode: 409, statusMessage: "候选已变化，请重新预览。" });
    await tx.memoryEvent.update({ where: { id: candidate.id }, data: { status: "ARCHIVED" } });
    await tx.auditLog.create({ data: { actorType: "USER", actorId: input.ownerId, characterId: input.characterId, action: "memory.event_archived", entityType: "MemoryEvent", entityId: candidate.id, details: { before: { title: candidate.title, status: candidate.status }, changed: ["status"], keepId: keep.id, reason, previewToken: input.token } } });
    return { candidate: { id: candidate.id, status: "ARCHIVED" as const }, keepId: keep.id };
  });
}
