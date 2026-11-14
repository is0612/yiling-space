import assert from "node:assert/strict";
import { prepareConversationSummary, refreshConversationSummary, shouldSummarizeConversation } from "../server/utils/conversation-summary";
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
 updateMany: async (q: { data: { metadata: unknown }; where: Record<string, unknown> }) => { writes++; assert.deepEqual(q.where.metadata, { equals: metadata }); if (cas) metadata = q.data.metadata; return { count: cas }; },
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
let calls = 0, sourceIds: string[] = [], longSummary = false;
globalThis.fetch = async (_url, init) => {
 calls++; if (modelFails) throw new Error("mock failure");
 const body = JSON.parse(String(init?.body)); const payload = JSON.parse(body.messages[1].content);
 sourceIds = payload.messages.map((row: { id: string }) => row.id);
 const summary = longSummary ? `头${"x".repeat(2000)}尾` : "测试接续摘要";
 return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary }) } }] }));
};
const input = { characterId: "character", conversationId: "conversation", memoryScopeId: "private", channelBindingId: null,
 model: "mock", apiKey: "fake", apiBaseUrl: "http://127.0.0.1:4010/v1", now };
try {
 const result = await refreshConversationSummary(prisma, input);
 assert.equal(result?.through.id, "019"); assert.equal(writes, 1); assert.equal(result?.coverage, "partial");
 assert.equal((metadata as Record<string, unknown>).unrelated, true);
 modelFails = true;
 assert.equal((await refreshConversationSummary(prisma, input))?.through.id, "019"); assert.equal(writes, 1);
 modelFails = false; cas = 0;
 assert.equal((await refreshConversationSummary(prisma, input))?.through.id, "019");
 cas = 1;
 assert.equal((await refreshConversationSummary(prisma, input))?.through.id, "039");
 assert.equal(sourceIds[0], "020", "cursor must continue from unprocessed evidence");
 rows = [];
 assert.equal((await refreshConversationSummary(prisma, input))?.through.id, "039", "source cleanup must preserve checkpoint");
 const before = calls;
 assert.equal(await refreshConversationSummary(prisma, { ...input, memoryScopeId: "other" }), null);
 assert.equal(await refreshConversationSummary(prisma, { ...input, channelBindingId: "other" }), null);
 assert.equal(calls, before);
 metadata = {}; binding = "binding";
 rows = Array.from({ length: 5 }, (_, n) => ({ id: `qq-${n}`, externalMessageId: `ext-${n}`, role: "USER", content: "test", occurredAt: n === 4 ? now : new Date(now.getTime() - 3600000 + n) }));
 const qq = { ...input, channelBindingId: binding, excludeExternalMessageIds: ["ext-4"] };
 assert.equal((await refreshConversationSummary(prisma, qq))?.through.id, "qq-3");
 assert(!sourceIds.includes("qq-4"), "pre-stored current input must not prevent idle closure or be summarized");
 let release!: () => void;
 const blocked = new Promise<void>(resolve => { release = resolve; });
 const fetchBefore = globalThis.fetch;
 globalThis.fetch = async (...args) => { await blocked; return fetchBefore(...args); };
 metadata = {}; rows = Array.from({ length: 25 }, (_, n) => ({ id: `bg-${n}`, externalMessageId: `bg-${n}`, role: "USER", content: "test", occurredAt: now }));
 const backgroundInput = { ...input, conversationId: "background", channelBindingId: binding };
 const beforeBackground = calls;
 assert.equal(await prepareConversationSummary(prisma, backgroundInput), null, "reply returns without waiting for blocked model");
 assert.equal(await prepareConversationSummary(prisma, backgroundInput), null, "concurrent reads reuse the active refresh");
 release();
 await new Promise(resolve => setTimeout(resolve, 20));
 assert.equal(calls, beforeBackground + 1, "one background call per conversation");
 await prepareConversationSummary(prisma, backgroundInput);
 assert.equal(calls, beforeBackground + 1, "cooldown prevents repeated checkpoint attempts on each message");
 globalThis.fetch = fetchBefore;
 // 超长摘要不能整条丢弃：截断到 1600 以内，游标必须继续推进（旧实现会永远卡住）。
 metadata = {}; rows = Array.from({ length: 25 }, (_, n) => ({ id: `long-${n}`, externalMessageId: `long-${n}`, role: "USER", content: "test", occurredAt: now }));
 longSummary = true;
 const longResult = await refreshConversationSummary(prisma, { ...input, channelBindingId: binding });
 const longStored = (metadata as Record<string, unknown>).continuitySummary as { summary: string };
 assert.equal(longResult?.through.id, "long-19", "oversized summary must still advance the cursor");
 assert.equal(longStored.summary.length, 1600, "oversized summary is clamped to the 1600-character budget");
 assert(longStored.summary.endsWith("尾"), "clamping keeps the newest tail");
 longSummary = false;
 metadata = {};
 modelFails = true;
 const failedInput = { ...backgroundInput, conversationId: "failed-background" };
 const beforeFailure = calls;
 await prepareConversationSummary(prisma, failedInput);
 await new Promise(resolve => setTimeout(resolve, 20));
 const afterFailure = calls;
 assert.equal(afterFailure, beforeFailure + 1);
 await prepareConversationSummary(prisma, failedInput);
 assert.equal(calls, afterFailure, "failed refresh must not retry on the next message");
 modelFails = false;
 console.log("Conversation summary mocks passed: nonblocking refresh, deduplication, cooldown, cursor/CAS and private isolation.");
} finally { globalThis.fetch = original; }
