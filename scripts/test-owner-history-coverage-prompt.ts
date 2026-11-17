import assert from "node:assert/strict";
import type { PrismaClient } from "../src/generated/prisma/client";
import { generateConversationReplyWithMemoryAssistant } from "../server/utils/memory-assistant";
import { planRestartedHistoryRetry, saveOwnerHistoryContext, type OwnerHistoryCoverage } from "../server/utils/owner-private-history";
import { generateConversationReply } from "../server/utils/chat-reply";

// A bare retry with no live task (typical right after a reload) must still reach tonight's records.
const dawn = new Date("2026-11-17T18:59:00Z");
const resumed = planRestartedHistoryRetry("123456789", dawn, "Asia/Shanghai");
assert(resumed, "A bare retry must rebuild a query instead of answering from an old denial");
assert.equal(resumed.groupId, "123456789");
assert.equal(resumed.direction, "earlier");
assert(Date.parse(resumed.start) <= Date.parse("2026-11-17T14:41:13Z"), "Tonight starts before the evening records");
assert(Date.parse(resumed.end) >= Date.parse("2026-11-17T16:30:53Z"), "Tonight reaches the latest records of that evening");

// The metadata may hold an unrelated summary with the history slot explicitly null.
// A completed read must be savable in that state, and must refresh the short task's start time.
const auth = { characterId: "character-a", bindingId: "binding-b", privateScopeId: "scope-c", conversationId: "conversation-d", ownerUid: "111111111" };
let written: Record<string, unknown> | undefined;
const storage = { conversation: {
  findFirst: async () => ({ metadata: { continuitySummary: { revision: 70 }, ownerHistoryContext: null } }),
  updateMany: async (args: { data: { metadata: Record<string, unknown> } }) => { written = args.data.metadata; return { count: 1 }; },
}, $transaction: async (run: (tx: unknown) => Promise<boolean>) => run(storage) } as unknown as PrismaClient;
assert.equal(await saveOwnerHistoryContext(storage, auth, null, resumed), true,
  "A null history slot plus a fresh page must still be saved");
assert.deepEqual(written?.ownerHistoryContext, resumed);
assert.equal((written?.continuitySummary as { revision: number }).revision, 70, "Unrelated metadata survives");

const coverage: OwnerHistoryCoverage = {
  groupIds: ["123456789"], start: "2026-11-17T10:00:00Z", end: "2026-11-17T18:37:36Z", direction: "earlier",
  count: 843, actualFirst: "2026-11-17T14:41:13Z", actualLast: "2026-11-17T16:30:53Z",
  sampledFirst: "2026-11-17T14:41:13Z", sampledLast: "2026-11-17T14:43:00Z", truncated: true, hasEarlier: true,
  oldestCursor: { id: "00000000-0000-4000-8000-000000000001", occurredAt: "2026-11-17T14:41:13Z" },
};
const base = { characterName: "测试角色", characterPrompt: "自然交流", model: "mock", apiKey: "test-only", apiBaseUrl: "https://model.invalid/v1",
  timeZone: "Asia/Shanghai", currentMessage: "查一下今晚那个群更早的聊天记录", speaker: { isOwner: true },
  recentMessages: [{ role: "ASSISTANT" as const, content: "之前错误地说零点前没有记录。" }], memories: [], snapshots: [],
  rawMessages: [{ id: "stale", content: "STALE_AUTOMATIC_SAMPLE", role: "USER", occurredAt: "2026-11-17T16:05:00Z", scope: "character" as const }],
};
const originalFetch = globalThis.fetch;
let calls = 0, loaded = false;
try {
  globalThis.fetch = async (_url, init) => {
    calls++;
    const body = JSON.parse(String(init?.body));
    const messages = body.messages as Array<{ role: string; content: string }>;
    const payload = JSON.parse(messages.find(message => message.role === "user")!.content);
    if (calls === 1) {
      assert(loaded, "Coverage and page must be read before the first response request");
      assert.equal(payload.ownerHistoryCoverage.count, 843);
      assert.equal(payload.ownerHistoryCoverage.hasEarlier, true);
      assert.equal(payload.ownerHistoryCoverage.truncated, true);
      assert.match(payload.ownerHistoryCoverage.actualFirst, /2026-11-17.*22:41:13/);
      assert(!JSON.stringify(payload.ownerHistoryCoverage).includes("oldestCursor"), "Internal pagination IDs stay out of the model payload");
      const prompt = JSON.stringify(messages);
      assert(prompt.includes("EARLIER_ORIGINAL_EVIDENCE"));
      assert(!prompt.includes("STALE_AUTOMATIC_SAMPLE"), "Current verified page replaces unrelated automatic samples");
      assert(prompt.includes("earlier records do exist"));
      assert(prompt.includes("Prefer this fresh evidence over prior conversational claims"));
    } else {
      assert.equal(payload.ownerHistoryCoverage, undefined, "Coverage is never exposed to a non-owner or group prompt");
    }
    return Response.json({ choices: [{ message: { content: JSON.stringify({ reply: "查到了更早的一段，这不是全部记录。" }) }, finish_reason: "stop" }] });
  };
  const result = await generateConversationReplyWithMemoryAssistant({
    chatInput: base, assistant: null, candidates: [], requiredHistoryLookup: { query: base.currentMessage, load: async () => {
      loaded = true;
      return { coverage, sources: [{ id: coverage.oldestCursor!.id, sourceKey: "message:test", sourceType: "message", scope: "character", relevanceScore: 1,
        role: "USER", content: "EARLIER_ORIGINAL_EVIDENCE", occurredAt: coverage.actualFirst! }] };
    } },
  });
  assert.equal(result.ownerHistoryCoverage?.count, 843);
  assert.equal(result.promptTemplateVersion, "conversation-retrieval-v71");
  for (const chatInput of [{ ...base, speaker: { isOwner: false } }, { ...base, groupChat: true }]) {
    await generateConversationReply({ ...chatInput, ownerHistoryCoverage: coverage });
  }
  assert.equal(calls, 3);
} finally { globalThis.fetch = originalFetch; }
console.log("Owner history coverage prompt integration passed (mock model, no database).");
