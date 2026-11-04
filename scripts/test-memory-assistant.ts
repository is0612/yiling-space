import assert from "node:assert/strict";
import {
  buildMemoryAssistantCandidates,
  generateConversationReplyWithMemoryAssistant,
  mergeModelUsage,
  resolveMemoryAssistantRuntime,
  selectMemoryAssistantSources,
  type MemoryAssistantCandidate,
} from "../server/utils/memory-assistant";
import type { ConversationReplyInput } from "../server/utils/chat-reply";

const now = new Date("2026-11-04T10:00:00.000Z");
const scopeOf = (scopeId: string) => scopeId === "global" ? "character" as const : "private" as const;

const candidates = buildMemoryAssistantCandidates({
  query: "我们以前聊过什么科幻电影",
  timeZone: "Asia/Shanghai",
  allowPrivate: false,
  scopeOf,
  memories: [
    {
      id: "memory-public",
      category: "FACT",
      content: "我们之前聊过科幻电影，尤其是太空探索题材。",
      confidence: 0.95,
      createdAt: now,
      updatedAt: now,
      memoryScopeId: "global",
    },
    {
      id: "memory-private",
      category: "FACT",
      content: "我们之前聊过科幻电影，尤其是太空探索题材。",
      confidence: 0.95,
      createdAt: now,
      updatedAt: now,
      memoryScopeId: "private-user-b",
    },
  ],
  snapshots: [
    {
      id: "snapshot-public",
      summary: "这一阶段聊过科幻电影和太空探索。",
      periodStart: new Date("2026-10-01T00:00:00.000Z"),
      periodEnd: new Date("2026-10-31T23:59:59.000Z"),
      version: 1,
      createdAt: now,
      memoryScopeId: "global",
    },
    {
      id: "snapshot-private",
      summary: "这一阶段聊过科幻电影和太空探索。",
      periodStart: new Date("2026-10-01T00:00:00.000Z"),
      periodEnd: new Date("2026-10-31T23:59:59.000Z"),
      version: 1,
      createdAt: now,
      memoryScopeId: "private-user-b",
    },
  ],
  rawMessages: [
    {
      id: "message-public",
      role: "USER",
      content: "我们之前聊过科幻电影，尤其是太空探索题材。",
      occurredAt: now,
      memoryScopeId: "global",
      speaker: "主人",
      isOwner: true,
    },
    {
      id: "message-private",
      role: "USER",
      content: "我们之前聊过科幻电影，尤其是太空探索题材。",
      occurredAt: now,
      memoryScopeId: "private-user-b",
      speaker: "另一位用户",
    },
  ],
  events: [
    {
      id: "event-public",
      title: "讨论科幻电影",
      detail: "聊到太空探索题材的电影。",
      occurredAt: new Date("2026-10-20T12:00:00.000Z"),
      participants: ["主人"],
      keywords: ["科幻", "电影", "太空"],
      memoryScopeId: "global",
    },
    {
      id: "event-private",
      title: "讨论科幻电影",
      detail: "聊到太空探索题材的电影。",
      occurredAt: new Date("2026-10-20T12:00:00.000Z"),
      participants: ["另一位用户"],
      keywords: ["科幻", "电影", "太空"],
      memoryScopeId: "private-user-b",
    },
  ],
});

assert(candidates.some((item) => item.sourceKey === "memory/memory-public"));
assert(candidates.some((item) => item.sourceKey === "snapshot/snapshot-public"));
assert(candidates.some((item) => item.sourceKey === "event/event-public"));
assert(candidates.some((item) => item.sourceKey === "message/message-public"));
assert(!candidates.some((item) => item.scope === "private"),
  "Private records must be removed before ranking and never reach group candidates.");

const selected = selectMemoryAssistantSources({
  sourceKeys: [
    "memory/memory-public",
    "memory/fake-id",
    "memory/memory-public",
    "snapshot/snapshot-public",
  ],
}, candidates, 1);
assert.equal(selected.length, 1, "Assistant source selection must respect its result limit.");
assert.equal(selected[0]?.sourceKey, "memory/memory-public",
  "Only exact candidate keys may be accepted; duplicate and invented keys must be ignored.");

const combined = mergeModelUsage(
  { promptTokens: 100, completionTokens: 20, totalTokens: 120, cacheHitTokens: 40, cacheMissTokens: 60 },
  { promptTokens: 50, completionTokens: 10, totalTokens: 60, cacheHitTokens: 10, cacheMissTokens: 40 },
);
assert.deepEqual(combined, {
  promptTokens: 150,
  completionTokens: 30,
  totalTokens: 180,
  cacheHitTokens: 50,
  cacheMissTokens: 100,
});
assert.equal(await resolveMemoryAssistantRuntime(
  { memoryAssistantEnabled: false, memoryAssistantModel: "unused" },
  "https://chat.example.com/v1",
), null, "Disabled memory assistant must not attempt to load its credentials.");
assert.equal(await resolveMemoryAssistantRuntime(
  { memoryAssistantEnabled: true, memoryAssistantModel: "memory-model" },
  "https://chat.example.com/v1",
), null, "A missing independent key must not fall back to the chat key.");

const chatInput: ConversationReplyInput = {
  characterName: "大肥鱼",
  characterPrompt: "你是一只爱聊天的大肥鱼。",
  model: "chat-model",
  apiKey: "chat-key-only",
  apiBaseUrl: "https://chat.example.com/v1",
  currentMessage: "我们上周聊的那部太空电影叫什么？",
  recentMessages: [],
  memories: [],
  snapshots: [],
};
const assistant = {
  model: "memory-model",
  apiKey: "memory-key-only",
  apiBaseUrl: "https://memory.example.com/v1",
};
const candidate: MemoryAssistantCandidate = {
  sourceKey: "memory/memory-1",
  sourceType: "memory",
  id: "memory-1",
  scope: "character",
  relevanceScore: 9.5,
  category: "FACT",
  content: "主人上周提到喜欢《星际穿越》，尤其喜欢其中的太空探索设定。",
  occurredAt: "2026-10-28T12:00:00.000Z",
};
const rawCandidate: MemoryAssistantCandidate = {
  sourceKey: "message/message-1",
  sourceType: "message",
  id: "message-1",
  scope: "character",
  relevanceScore: 8,
  role: "USER",
  content: "当时我说我很喜欢《星际穿越》的太空探索设定。",
  occurredAt: "2026-10-28T12:00:00.000Z",
  speaker: "主人",
  isOwner: true,
};

const originalFetch = globalThis.fetch;
try {
  const calls: Array<{ url: string; authorization: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    calls.push({ url, authorization: headers.get("authorization") ?? "", body });

    if (url.includes("memory.example.com")) {
      return new Response(JSON.stringify({
        model: "memory-model",
        choices: [{ message: { content: JSON.stringify({
          sourceKeys: ["memory/memory-1", "message/message-1", "memory/invented"],
        }) } }],
        usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }

    const chatCallNumber = calls.filter((call) => call.url.includes("chat.example.com")).length;
    const content = chatCallNumber === 1
      ? {
          reply: "让我想想……",
          memoryAssistantQuery: "上周讨论的太空电影名称",
          usedMemoryIds: [],
          usedSnapshotIds: [],
          usedEventIds: [],
        }
      : {
          reply: "是《星际穿越》！你当时还说很喜欢它的太空探索设定。",
          usedMemoryIds: ["memory-1", "memory-invented"],
          usedRawMessageIds: ["message-1", "message-invented"],
          usedSnapshotIds: [],
          usedEventIds: [],
        };
    return new Response(JSON.stringify({
      model: "chat-model",
      choices: [{ message: { content: JSON.stringify(content) }, finish_reason: "stop" }],
      usage: { prompt_tokens: chatCallNumber === 1 ? 100 : 200, completion_tokens: 20, total_tokens: chatCallNumber === 1 ? 120 : 220 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const result = await generateConversationReplyWithMemoryAssistant({
    chatInput,
    assistant,
    candidates: [candidate, rawCandidate],
  });
  assert.equal(calls.length, 3, "A requested search should make one initial chat call, one read-only lookup, and one final chat call.");
  assert.equal(calls[0]?.authorization, "Bearer chat-key-only");
  assert.equal(calls[1]?.authorization, "Bearer memory-key-only",
    "The memory assistant must use its own credential, never the chat credential.");
  assert.equal(calls[2]?.authorization, "Bearer chat-key-only");
  const finalMessages = calls[2]?.body.messages as Array<{ role: string; content: string }>;
  assert(finalMessages.some((message) => message.content.includes(candidate.content)),
    "Only validated memory evidence should be appended to the final chat prompt.");
  assert(finalMessages.some((message) => message.content.includes(rawCandidate.content)),
    "Validated original-message evidence should also be appended to the final chat prompt.");
  assert.equal(result.reply, "是《星际穿越》！你当时还说很喜欢它的太空探索设定。");
  assert.deepEqual(result.usedMemoryIds, ["memory-1"],
    "Final chat source IDs must still be checked against the supplied evidence whitelist.");
  assert.deepEqual(result.usedRawMessageIds, ["message-1"],
    "Original message source IDs must also be checked against the raw-message whitelist.");
  assert.equal(result.memoryAssistantSources?.length, 2);
  assert.equal(result.memoryAssistantSources?.[0]?.id, "memory-1");
  assert.equal(result.usage?.totalTokens, 340, "The two main-model calls should be combined for chat usage.");
  assert.equal(result.memoryAssistantUsage?.totalTokens, 40,
    "Memory assistant usage must remain independently attributable.");
  const firstSystem = (calls[0]?.body.messages as Array<{ role: string; content: string }>)[0]?.content ?? "";
  assert(firstSystem.includes("memoryAssistantQuery"),
    "The first chat pass must know when and how it may request a deeper search.");

  // If the optional assistant is unavailable, return the first chat reply instead of failing the turn.
  const fallbackCalls: string[] = [];
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    fallbackCalls.push(url);
    if (url.includes("memory.example.com")) {
      return new Response("unavailable", { status: 503 });
    }
    return new Response(JSON.stringify({
      model: "chat-model",
      choices: [{
        message: { content: JSON.stringify({
          reply: "我一时想不起来，得再找找。",
          memoryAssistantQuery: "上周讨论的太空电影名称",
          usedMemoryIds: [],
          usedSnapshotIds: [],
          usedEventIds: [],
        }) },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const fallback = await generateConversationReplyWithMemoryAssistant({
    chatInput,
    assistant,
    candidates: [candidate],
  });
  assert.equal(fallbackCalls.length, 2);
  assert.equal(fallback.reply, "我一时想不起来，得再找找。");
  assert.equal(fallback.memoryAssistantSources, undefined,
    "An unavailable assistant must not leak unverified sources into the reply.");

  // No query means one regular chat call; the optional assistant adds no normal-turn request.
  let noQueryCalls = 0;
  globalThis.fetch = async (): Promise<Response> => {
    noQueryCalls += 1;
    return new Response(JSON.stringify({
      model: "chat-model",
      choices: [{
        message: { content: JSON.stringify({
          reply: "今天就聊点轻松的吧。",
          usedMemoryIds: [],
          usedSnapshotIds: [],
          usedEventIds: [],
        }) },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 80, completion_tokens: 10, total_tokens: 90 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const ordinary = await generateConversationReplyWithMemoryAssistant({
    chatInput,
    assistant,
    candidates: [candidate],
  });
  assert.equal(noQueryCalls, 1, "The memory assistant must not add latency or cost when no lookup is requested.");
  assert.equal(ordinary.reply, "今天就聊点轻松的吧。");
} finally {
  globalThis.fetch = originalFetch;
}

console.log("Memory assistant tests passed: scope isolation, source whitelist, independent credentials, on-demand lookup, usage accounting, and fail-open fallback.");
