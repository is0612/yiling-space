import assert from "node:assert/strict";
import { prepareConversationSummary, shouldSummarizeConversation } from "../server/utils/conversation-summary";
import type { PrismaClient } from "../src/generated/prisma/client";
const now = new Date("2026-11-13T12:00:00Z");
assert(!shouldSummarizeConversation(3, new Date(0), now));
assert(shouldSummarizeConversation(4, new Date(now.getTime() - 1800000), now));
assert(shouldSummarizeConversation(24, now, now));
let writes = 0, modelFails = false, cas = 1, binding: string | null = null;
let metadata: unknown = { unrelated: true };
let rows = Array.from({ length: 50 }, (_, n) => ({ id: String(n).padStart(3, "0"), externalMessageId: `ext-${n}`, role: "USER", content: `test ${n}`, occurredAt: new Date(now.getTime() - 100000 + n) }));
const prisma = { conversation: {
 findFirst: async (q: { where: Record<string, unknown> }) => q.where.memoryScopeId === "private" && q.where.channelBindingId === binding && q.where.characterId === "character" ? { metadata, updatedAt: now } : null,
 updateMany: async (q: { data: { metadata: unknown }; where: Record<string, unknown> }) => { writes++; assert.equal(q.where.updatedAt, now); if (cas) metadata = q.data.metadata; return { count: cas }; },
}, message: { findMany: async (q: { where: { OR?: Array<{ occurredAt: Date | { gt: Date }; id?: { gt: string } }>; AND?: Array<{ OR: Array<{ externalMessageId: null | { notIn: string[] } }> }> }; take: number }) => {
 const exclude = q.where.AND?.[0]?.OR[1]?.externalMessageId;
 const selected = rows.filter(row => {
  if (exclude && typeof exclude === "object" && exclude.notIn.includes(row.externalMessageId)) return false;
  if (!q.where.OR) return true;
  return q.where.OR.some(condition => condition.occurredAt instanceof Date ? row.occurredAt.getTime() === condition.occurredAt.getTime() && row.id > condition.id!.gt : row.occurredAt > condition.occurredAt.gt);
 });
 return selected.slice(0, q.take);
} } } as unknown as PrismaClient;
const original = globalThis.fetch;
let calls = 0, sourceIds: string[] = [];
globalThis.fetch = async (_url, init) => {
 calls++; if (modelFails) throw new Error("mock failure");
 const body = JSON.parse(String(init?.body)); const payload = JSON.parse(body.messages[1].content);
 sourceIds = payload.messages.map((row: { id: string }) => row.id);
 return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: "测试接续摘要" }) } }] }));
};
const input = { characterId: "character", conversationId: "conversation", memoryScopeId: "private", channelBindingId: null,
 model: "mock", apiKey: "fake", apiBaseUrl: "http://127.0.0.1:4010/v1", now };
try {
 const result = await prepareConversationSummary(prisma, input);
 assert.equal(result?.through.id, "019"); assert.equal(writes, 1); assert.equal(result?.coverage, "partial");
 assert.equal((metadata as Record<string, unknown>).unrelated, true);
 modelFails = true;
 assert.equal((await prepareConversationSummary(prisma, input))?.through.id, "019"); assert.equal(writes, 1);
 modelFails = false; cas = 0;
 assert.equal((await prepareConversationSummary(prisma, input))?.through.id, "019");
 cas = 1;
 assert.equal((await prepareConversationSummary(prisma, input))?.through.id, "039");
 assert.equal(sourceIds[0], "020", "cursor must continue from unprocessed evidence");
 rows = [];
 assert.equal((await prepareConversationSummary(prisma, input))?.through.id, "039", "source cleanup must preserve checkpoint");
 const before = calls;
 assert.equal(await prepareConversationSummary(prisma, { ...input, memoryScopeId: "other" }), null);
 assert.equal(await prepareConversationSummary(prisma, { ...input, channelBindingId: "other" }), null);
 assert.equal(calls, before);
 metadata = {}; binding = "binding";
 rows = Array.from({ length: 5 }, (_, n) => ({ id: `qq-${n}`, externalMessageId: `ext-${n}`, role: "USER", content: "test", occurredAt: n === 4 ? now : new Date(now.getTime() - 3600000 + n) }));
 const qq = { ...input, channelBindingId: binding, excludeExternalMessageIds: ["ext-4"] };
 assert.equal((await prepareConversationSummary(prisma, qq))?.through.id, "qq-3");
 assert(!sourceIds.includes("qq-4"), "pre-stored current input must not prevent idle closure or be summarized");
 console.log("Conversation summary mocks passed: triggers, cursor continuation, failure/CAS, private scope/binding, cleanup retention and QQ pre-stored input.");
} finally { globalThis.fetch = original; }
