import assert from "node:assert/strict";
import type { PrismaClient } from "../src/generated/prisma/client";
import { loadConversationWorkingContext as load, saveConversationWorkingContext as save } from "../server/utils/conversation-working-context";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const now = new Date("2026-01-02T12:00:00Z");
const characterId = uuid(1), conversationId = uuid(2);
type Row = { id: string; conversationId: string; externalMessageId: string; role: string; content: string; occurredAt: Date; metadata: { authorOpenId: string } };
function fixture() {
  let conversation = { id: conversationId, characterId, channelBindingId: uuid(3) as string | null, externalConversationId: "g:example", metadata: { other: { preserved: true } } as Record<string, unknown>, updatedAt: new Date(now.getTime() - 1000) };
  let rows: Row[] = Array.from({ length: 18 }, (_, i) => ({ id: uuid(100 + i), conversationId, externalMessageId: `external-${i}`, role: i % 2 ? "ASSISTANT" : "USER", content: "original-evidence-" + "x".repeat(700), occurredAt: new Date(now.getTime() - 30_000 + i * 1000), metadata: { authorOpenId: "stable-author" } }));
  let conflict = false, messageReads = 0;
  const api = {
    conversation: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        if (where.id !== conversation.id || where.characterId !== conversation.characterId || !conversation.channelBindingId || !conversation.externalConversationId.startsWith("g:")) return null;
        return structuredClone(conversation);
      },
      updateMany: async ({ where, data }: { where: { updatedAt: Date }; data: { metadata: Record<string, unknown>; updatedAt: Date } }) => {
        if (conflict) { conflict = false; conversation.metadata.concurrent = true; conversation.updatedAt = new Date(conversation.updatedAt.getTime() + 10); }
        if (where.updatedAt.getTime() !== conversation.updatedAt.getTime()) return { count: 0 };
        conversation = { ...conversation, ...structuredClone(data) };
        return { count: 1 };
      },
    },
    message: { findMany: async ({ where, take }: { where: { conversationId: string; id: { in: string[] }; role: { in: string[] } }; take: number }) => {
      messageReads++;
      return structuredClone(rows.filter(row => row.conversationId === where.conversationId && where.id.in.includes(row.id) && where.role.in.includes(row.role)).slice(0, take));
    } },
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(api),
  };
  const prisma = api as unknown as PrismaClient;
  const input = (index = 15, expectedRevision = 0) => ({ conversationId, characterId, expectedRevision, summary: "The group agreed to continue the topic.", evidenceMessageIds: [rows[0]!.id, rows[1]!.id], cursor: { id: rows[index]!.id, occurredAt: rows[index]!.occurredAt }, now });
  return { prisma, input, get conversation() { return conversation; }, get rows() { return rows; }, set rows(value: Row[]) { rows = value; }, set conflict(value: boolean) { conflict = value; }, get reads() { return messageReads; } };
}

{
  const f = fixture();
  assert.equal(await load(f.prisma, { conversationId, characterId, now }), null);
  assert.equal(await save(f.prisma, { ...f.input(), summary: "s".repeat(2000), evidenceMessageIds: [...f.rows.slice(0, 15).map(row => row.id), f.rows[0]!.id, "bad"] }), true);
  const state = f.conversation.metadata.workingContext as { revision: number; summary: string; evidenceMessageIds: string[] };
  assert.equal(state.summary.length, 1600);
  assert.equal(state.evidenceMessageIds.length, 12);
  assert.deepEqual(f.conversation.metadata.other, { preserved: true });
  assert(!JSON.stringify(f.conversation.metadata).includes("original-evidence"), "Metadata stores ids, never evidence text.");
  const loaded = await load(f.prisma, { conversationId, characterId, now });
  assert.equal(loaded?.revision, 1);
  assert.equal(loaded?.evidence.length, 12);
  assert.equal(loaded?.evidence[0]?.content.length, 600);
  assert.equal(loaded?.evidence[0]?.metadata?.authorOpenId, "stable-author");
  assert.equal(loaded?.evidence[1]?.role, "ASSISTANT");
  assert.equal(await save(f.prisma, f.input(16, 0)), false, "Stale revision fails.");
  assert.equal(await save(f.prisma, f.input(14, 1)), false, "Older cursor fails.");
  assert.equal(await save(f.prisma, f.input(15, 1)), false, "Same cursor fails.");
  assert.equal(await save(f.prisma, { ...f.input(16, 1), cursor: { id: f.rows[16]!.id, occurredAt: now } }), false, "Forged cursor time fails.");
  f.conflict = true;
  assert.equal(await save(f.prisma, f.input(16, 1)), false, "Concurrent metadata update wins CAS.");
  assert.equal(f.conversation.metadata.concurrent, true);
  assert.equal((f.conversation.metadata.workingContext as typeof state).revision, 1);
  assert.equal(await save(f.prisma, f.input(16, 1)), true);
}
{
  const f = fixture();
  assert(await save(f.prisma, { ...f.input(), summary: "member_12 promised something" }));
  const loaded = await load(f.prisma, { conversationId, characterId, now });
  assert.equal(loaded?.summary, "");
  assert.equal(loaded?.evidence.length, 2, "Reject member-code summary but retain real sources.");
  const state = f.conversation.metadata.workingContext as Record<string, unknown>;
  state.summary = "legacy member_1 prose";
  assert.equal((await load(f.prisma, { conversationId, characterId, now }))?.summary, "");
  const expiry = new Date(now.getTime() + 86_400_000);
  const reads = f.reads;
  assert.equal(await load(f.prisma, { conversationId, characterId, now: expiry }), null);
  assert.equal(f.reads, reads, "Expired entries do not read evidence.");
  assert(await save(f.prisma, { ...f.input(16), now: expiry }));
  assert.equal((f.conversation.metadata.workingContext as { revision: number }).revision, 2);
}
{
  const f = fixture();
  f.rows[1]!.conversationId = uuid(99);
  f.rows[2]!.role = "SYSTEM";
  assert(await save(f.prisma, { ...f.input(), evidenceMessageIds: [f.rows[0]!.id, f.rows[1]!.id, f.rows[2]!.id, uuid(999)] }));
  assert.deepEqual((f.conversation.metadata.workingContext as { evidenceMessageIds: string[] }).evidenceMessageIds, [f.rows[0]!.id]);
  assert.equal((await load(f.prisma, { conversationId, characterId, now }))?.summary, "", "Any missing requested evidence invalidates summary.");
}
{
  const f = fixture();
  assert(await save(f.prisma, f.input()));
  f.rows = f.rows.filter(row => row.id !== uuid(100));
  const loaded = await load(f.prisma, { conversationId, characterId, now });
  assert.equal(loaded?.summary, "", "Deleted evidence invalidates cached summary.");
  assert.equal(loaded?.evidence.length, 1);
  assert(await save(f.prisma, { ...f.input(16, 1), evidenceMessageIds: [uuid(101)] }));
  assert.equal((await load(f.prisma, { conversationId, characterId, now }))?.summary, "", "Removed old sources cannot survive through a new summary.");
}
for (const mode of ["character", "conversation", "private", "desktop"]) {
  const f = fixture();
  if (mode === "private") f.conversation.externalConversationId = "c:example";
  if (mode === "desktop") f.conversation.channelBindingId = null;
  const opts = { conversationId: mode === "conversation" ? uuid(99) : conversationId, characterId: mode === "character" ? uuid(99) : characterId, now };
  assert.equal(await load(f.prisma, opts), null);
  assert.equal(await save(f.prisma, { ...f.input(), ...opts }), false);
}
{
  const f = fixture();
  f.rows[16]!.occurredAt = f.rows[15]!.occurredAt;
  assert(await save(f.prisma, f.input()));
  assert(await save(f.prisma, f.input(16, 1)), "UUID breaks equal-timestamp ties.");
  assert.equal(await save(f.prisma, f.input(15, 2)), false);
}
console.log("Conversation working context mock tests passed (no database or model calls).");
