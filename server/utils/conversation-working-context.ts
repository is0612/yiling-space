import type { Prisma, PrismaClient } from "../../src/generated/prisma/client";
const TTL_MS = 86_400_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
type Cursor = { id: string; occurredAt: Date };
type Stored = { revision: number; summary: string; evidenceMessageIds: string[]; cursor: Cursor; updatedAt: Date };
export type ConversationWorkingContext = {
  revision: number; summary: string;
  evidence: Array<{ id: string; externalMessageId: string | null; role: "USER" | "ASSISTANT"; content: string; occurredAt: Date; metadata: Prisma.JsonValue | null }>;
  cursor: Cursor; updatedAt: Date;
};
const record = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
function date(v: unknown): Date | null {
  if (!(v instanceof Date) && typeof v !== "string") return null;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
}
const ids = (v: unknown): string[] => Array.isArray(v) ? [...new Set(v.filter((id): id is string => typeof id === "string" && UUID.test(id)).map(id => id.toLowerCase()))].slice(0, 12) : [];
const cleanSummary = (v: unknown): string => typeof v === "string" && !/member_\d+/iu.test(v) ? v.trim().slice(0, 1600) : "";
function stored(v: unknown): Stored | null {
  const r = record(v), c = record(r.cursor);
  const occurredAt = date(c.occurredAt), updatedAt = date(r.updatedAt);
  if (!Number.isSafeInteger(r.revision) || Number(r.revision) < 1 || typeof c.id !== "string" || !UUID.test(c.id) || !occurredAt || !updatedAt) return null;
  return { revision: Number(r.revision), summary: cleanSummary(r.summary), evidenceMessageIds: ids(r.evidenceMessageIds), cursor: { id: c.id.toLowerCase(), occurredAt }, updatedAt };
}
const live = (s: Stored, now: Date): boolean => now.getTime() >= s.updatedAt.getTime() && now.getTime() - s.updatedAt.getTime() < TTL_MS;
const later = (a: Cursor, b: Cursor): boolean => a.occurredAt.getTime() > b.occurredAt.getTime() || (a.occurredAt.getTime() === b.occurredAt.getTime() && a.id > b.id);
const groupWhere = (conversationId: string, characterId: string) => ({ id: conversationId, characterId, channelBindingId: { not: null }, externalConversationId: { startsWith: "g:" } });

/** Temporary continuity only: rehydrate original evidence, never infer long-term facts. */
export async function loadConversationWorkingContext(prisma: Pick<PrismaClient, "conversation" | "message">, options: { conversationId: string; characterId: string; now?: Date }): Promise<ConversationWorkingContext | null> {
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) return null;
  const conversation = await prisma.conversation.findFirst({ where: groupWhere(options.conversationId, options.characterId), select: { metadata: true } });
  const context = conversation && stored(record(conversation.metadata).workingContext);
  if (!context || !live(context, now)) return null;
  const rows = context.evidenceMessageIds.length ? await prisma.message.findMany({
    where: { conversationId: options.conversationId, id: { in: context.evidenceMessageIds }, role: { in: ["USER", "ASSISTANT"] } }, take: 12,
    select: { id: true, externalMessageId: true, role: true, content: true, occurredAt: true, metadata: true },
  }) : [];
  const byId = new Map(rows.map(row => [row.id, row]));
  const evidence: ConversationWorkingContext["evidence"] = context.evidenceMessageIds.flatMap(id => {
    const row = byId.get(id);
    return row && (row.role === "USER" || row.role === "ASSISTANT") ? [{ ...row, role: row.role, content: row.content.slice(0, 600) }] : [];
  });
  return { revision: context.revision, summary: evidence.length && evidence.length === context.evidenceMessageIds.length ? context.summary : "", evidence, cursor: context.cursor, updatedAt: context.updatedAt };
}

/** Transaction read + updatedAt CAS preserves unrelated metadata and rejects stale rounds. */
export async function saveConversationWorkingContext(prisma: PrismaClient, options: { conversationId: string; characterId: string; expectedRevision: number; summary: string; evidenceMessageIds: string[]; cursor: Cursor; now?: Date }): Promise<boolean> {
  const now = options.now ?? new Date(), occurredAt = date(options.cursor?.occurredAt);
  if (!Number.isFinite(now.getTime()) || !occurredAt || occurredAt > now || typeof options.cursor?.id !== "string" || !UUID.test(options.cursor.id) || !Number.isSafeInteger(options.expectedRevision) || options.expectedRevision < 0) return false;
  const cursor = { id: options.cursor.id.toLowerCase(), occurredAt };
  return prisma.$transaction(async tx => {
    const conversation = await tx.conversation.findFirst({ where: groupWhere(options.conversationId, options.characterId), select: { metadata: true, updatedAt: true } });
    if (!conversation) return false;
    const metadata = record(conversation.metadata), previous = stored(metadata.workingContext);
    // An expired load is null: expectedRevision=0 restarts, but revision and cursor remain monotonic.
    if (options.expectedRevision !== (previous && live(previous, now) ? previous.revision : 0) || (previous && !later(cursor, previous.cursor)) || (previous && previous.revision >= Number.MAX_SAFE_INTEGER)) return false;
    const requested = ids(options.evidenceMessageIds);
    const rows = await tx.message.findMany({
      where: { conversationId: options.conversationId, id: { in: [...new Set([...requested, ...(previous?.evidenceMessageIds ?? []), cursor.id])] }, role: { in: ["USER", "ASSISTANT"] } }, take: 25,
      select: { id: true, role: true, occurredAt: true },
    });
    const actualCursor = rows.find(row => row.id === cursor.id && (row.role === "USER" || row.role === "ASSISTANT"));
    if (!actualCursor || actualCursor.occurredAt.getTime() !== cursor.occurredAt.getTime()) return false;
    const verified = new Set(rows.filter(row => (row.role === "USER" || row.role === "ASSISTANT") && !later({ id: row.id, occurredAt: row.occurredAt }, cursor)).map(row => row.id));
    const evidenceMessageIds = requested.filter(id => verified.has(id));
    const workingContext = { revision: (previous?.revision ?? 0) + 1, summary: evidenceMessageIds.length === requested.length && evidenceMessageIds.length && (previous?.evidenceMessageIds ?? []).every(id => verified.has(id)) ? cleanSummary(options.summary) : "", evidenceMessageIds, cursor: { id: cursor.id, occurredAt: cursor.occurredAt.toISOString() }, updatedAt: now.toISOString() };
    const result = await tx.conversation.updateMany({
      where: { ...groupWhere(options.conversationId, options.characterId), updatedAt: conversation.updatedAt },
      data: { metadata: { ...metadata, workingContext } as Prisma.InputJsonObject, updatedAt: new Date(Math.max(now.getTime(), conversation.updatedAt.getTime() + 1)) },
    });
    return result.count === 1;
  });
}
