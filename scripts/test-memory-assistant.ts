import assert from "node:assert/strict";
import {
  buildDeterministicTimelineMemoryQuery,
  buildMemoryAssistantCandidates,
  estimateMemoryAssistantTokens,
  fitMemoryAssistantCandidates,
  generateConversationReplyWithMemoryAssistant,
  mergeModelUsage,
  resolveMemoryAssistantRuntime,
  selectMemoryAssistantSources,
  testMemoryAssistantConnection,
  type MemoryAssistantCandidate,
} from "../server/utils/memory-assistant";
import type { TurnDetailPatch } from "../server/utils/model-turn-detail";
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

const firstInteractionQuery = buildDeterministicTimelineMemoryQuery("你记得第一次跟小七说话是哪天吗");
assert(firstInteractionQuery?.includes("小七"), "A named-person first-interaction question must become a deterministic lookup.");
assert(firstInteractionQuery?.includes("第一次跟小七说话"), "The original question must remain available to the retrieval assistant.");
assert(buildDeterministicTimelineMemoryQuery("最近一次和昔涟聊天是什么时候")?.includes("昔涟"),
  "Latest-interaction questions must also trigger a timeline lookup.");
assert.equal(buildDeterministicTimelineMemoryQuery("今天晚饭吃什么"), null,
  "Ordinary questions must not trigger a timeline lookup.");

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
  maxTokens: 512,
  currentMessage: "我们上周聊的那部太空电影叫什么？",
  recentMessages: [],
  memories: [],
  snapshots: [],
};
const assistant = {
  model: "memory-model",
  apiKey: "memory-key-only",
  apiBaseUrl: "https://memory.example.com/v1",
  temperature: 0.1,
  maxInputTokens: 12_288,
  maxOutputTokens: 2_048,
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

  const details: TurnDetailPatch[] = [];
  const onTurnDetail = (detail: TurnDetailPatch) => { details.push(detail); };
  let candidateLoaderCalls = 0;
  const result = await generateConversationReplyWithMemoryAssistant({
    chatInput,
    assistant,
    candidates: [],
    onTurnDetail,
    loadCandidates: async (query) => {
      candidateLoaderCalls += 1;
      assert.equal(query, "上周讨论的太空电影名称");
      return [candidate, rawCandidate];
    },
  });
  assert.equal(details[0]?.memory?.status, "success");
  assert.deepEqual(details[0]?.memory?.sources?.map(source => [source.id, source.type, source.content, source.occurredAt]),
    [[candidate.id, "memory", candidate.content, candidate.occurredAt], [rawCandidate.id, "message", rawCandidate.content, rawCandidate.occurredAt]]);
  assert.equal(details[0]?.memory?.query, "上周讨论的太空电影名称");
  assert.equal(candidateLoaderCalls, 1, "Historical database candidates should load only after the chat model requests a search.");
  assert.equal(calls.length, 3, "A requested search should make one initial chat call, one read-only lookup, and one final chat call.");
  assert.equal(calls[0]?.authorization, "Bearer chat-key-only");
  assert.equal(calls[0]?.body.max_tokens, 512, "The main chat model must retain its own configured token limit.");
  assert.equal(calls[1]?.authorization, "Bearer memory-key-only",
    "The memory assistant must use its own credential, never the chat credential.");
  assert.equal(calls[1]?.body.max_tokens, 1_638, "The first memory lookup uses 80% of its own output ceiling.");
  assert.equal(calls[1]?.body.temperature, 0.1, "Memory assistant temperature is independent from chat temperature.");
  assert.equal(calls[1]?.body.thinking, undefined, "Do not send DeepSeek-only thinking fields to other providers.");
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
          responseExplanation: "准备查询历史记录。",
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
    onTurnDetail,
    chatInput,
    assistant,
    candidates: [],
    loadCandidates: async () => [candidate],
  });
  assert.equal(details.at(-1)?.memory?.status, "failed");
  assert.equal(fallbackCalls.length, 2);
  assert.equal(fallback.reply, "本宝刚才想去翻以前的记录，但这次检索没成功，先不乱告诉你。",
    "A failed lookup must replace the first-pass waiting reply with an explicit retrieval-failure message.");
  assert.equal(fallback.responseExplanation, undefined, "Fallback text must not retain an explanation of the discarded waiting reply.");
  assert.equal(fallback.memoryAssistantStatus, "failed");
  assert.equal(fallback.memoryAssistantFailureReason, "http_error");
  assert.equal(fallback.memoryAssistantAttempts, 1, "HTTP errors must not be retried as if they were malformed model output.");
  assert.equal(fallback.memoryAssistantHttpStatus, 503);
  assert.equal(fallback.memoryAssistantSources, undefined,
    "An unavailable assistant must not leak unverified sources into the reply.");

  // No query means one regular chat call; the optional assistant adds no normal-turn request.
  let noQueryCalls = 0;
  let noQueryLoaderCalls = 0;
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
    onTurnDetail,
    chatInput,
    assistant,
    candidates: [],
    loadCandidates: async () => {
      noQueryLoaderCalls += 1;
      return [candidate];
    },
  });
  assert.equal(noQueryCalls, 1, "The memory assistant must not add latency or cost when no lookup is requested.");
  assert.equal(noQueryLoaderCalls, 0, "No broad database scan should run unless a historical search is requested.");
  assert.equal(ordinary.reply, "今天就聊点轻松的吧。");
  assert.equal(details.at(-1)?.memory?.status, "not_needed");

  // A named-person timeline question must still invoke the independent assistant
  // when the main model forgets to emit memoryAssistantQuery.
  const automaticCalls: string[] = [];
  let automaticChatCalls = 0;
  globalThis.fetch = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    automaticCalls.push(url);
    if (url.includes("memory.example.com")) {
      return Response.json({
        choices: [{ message: { content: JSON.stringify({ sourceKeys: ["message/message-1"] }) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 30, completion_tokens: 5, total_tokens: 35 },
      });
    }
    automaticChatCalls += 1;
    const content = automaticChatCalls === 1
      ? { reply: "我记得好像是十月底。", usedMemoryIds: [], usedSnapshotIds: [], usedEventIds: [] }
      : { reply: "查到的最早记录是 10 月 30 日。", usedMemoryIds: [], usedSnapshotIds: [], usedEventIds: [], usedRawMessageIds: ["message-1"] };
    return Response.json({
      model: "chat-model",
      choices: [{ message: { content: JSON.stringify(content) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 80, completion_tokens: 10, total_tokens: 90 },
    });
  };
  const automaticDetail: TurnDetailPatch[] = [];
  const automatic = await generateConversationReplyWithMemoryAssistant({
    chatInput: { ...chatInput, currentMessage: "你记得第一次跟小七说话是哪天吗" },
    assistant,
    candidates: [],
    onTurnDetail: detail => { automaticDetail.push(detail); },
    loadCandidates: async query => {
      assert(query.includes("小七"));
      return [rawCandidate];
    },
  });
  assert.equal(automatic.reply, "查到的最早记录是 10 月 30 日。");
  assert.equal(automaticCalls.filter(url => url.includes("memory.example.com")).length, 1,
    "The deterministic timeline guard must cause a real request using the independent memory API.");
  assert.equal(automaticChatCalls, 2, "The main model must compose its final answer after evidence retrieval.");
  assert.equal(automaticDetail[0]?.memory?.status, "success");
  assert(automaticDetail[0]?.memory?.query?.includes("小七"));

  await generateConversationReplyWithMemoryAssistant({ chatInput, assistant: null, candidates: [], onTurnDetail });
  assert.equal(details.at(-1)?.memory?.status, "not_enabled");
  await generateConversationReplyWithMemoryAssistant({ chatInput, assistant, candidates: [], onTurnDetail });
  assert.equal(details.at(-1)?.memory?.status, "no_sources");
  await generateConversationReplyWithMemoryAssistant({ chatInput, assistant, candidates: [candidate],
    onTurnDetail: () => { throw new Error("diagnostic unavailable"); } });

  globalThis.fetch = async () => Response.json({ choices: [{ message: { content: JSON.stringify({
    reply: "让我去翻翻", memoryAssistantQuery: "上周电影", usedMemoryIds: [], usedSnapshotIds: [],
  }) } }] });
  await generateConversationReplyWithMemoryAssistant({ chatInput, assistant, candidates: [], onTurnDetail,
    loadCandidates: async () => [] });
  assert.equal(details.at(-1)?.memory?.status, "no_sources");
  assert.deepEqual(details.at(-1)?.memory?.sources, []);
  await generateConversationReplyWithMemoryAssistant({ chatInput, assistant, candidates: [], onTurnDetail,
    loadCandidates: async () => { throw new Error("candidate load unavailable"); } });
  assert.equal(details.at(-1)?.memory?.status, "failed");

  globalThis.fetch = async () => Response.json({ choices: [{ message: { content: JSON.stringify({
    action: "silent", reply: "", memoryAssistantQuery: "上周电影", usedMemoryIds: [], usedSnapshotIds: [],
  }) } }] });
  const silent = await generateConversationReplyWithMemoryAssistant({
    chatInput: { ...chatInput, groupChat: true, allowSilent: true }, assistant, candidates: [candidate], onTurnDetail,
    loadCandidates: async () => { throw new Error("silent turns must not retrieve"); },
  });
  assert.equal(silent.action, "silent");
  assert.deepEqual(details.at(-1)?.memory, { status: "not_needed" });
} finally {
  globalThis.fetch = originalFetch;
}


const deepSeekAssistant = {
  model: "deepseek-flash",
  apiKey: "deepseek-memory-key-only",
  apiBaseUrl: "https://api.deepseek.com/v1",
  temperature: 0.1,
  maxInputTokens: 12_288,
  maxOutputTokens: 2_048,
};
const diagnosticLogs: unknown[][] = [];
const originalWarn = console.warn;
try {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    requests.push({ url, body });

    if (url.includes("api.deepseek.com")) {
      const attempt = requests.filter((item) => item.url.includes("api.deepseek.com")).length;
      if (attempt === 1) {
        return new Response(JSON.stringify({
          model: "deepseek-flash",
          choices: [{ message: { content: "" }, finish_reason: "length" }],
          usage: { prompt_tokens: 400, completion_tokens: 2048, total_tokens: 2448 },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        model: "deepseek-flash",
        choices: [{ message: { content: JSON.stringify({ sourceKeys: ["memory/memory-1"] }) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 300, completion_tokens: 20, total_tokens: 320 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }

    const isFinal = requests.filter((item) => item.url.includes("chat.example.com")).length > 1;
    const reply = isFinal
      ? { reply: "你之前提到过喜欢《星际穿越》。", usedMemoryIds: ["memory-1"], usedSnapshotIds: [], usedEventIds: [] }
      : { memoryAssistantQuery: "之前你说过的太空电影是什么？" };
    return new Response(JSON.stringify({
      model: "chat-model",
      choices: [{ message: { content: JSON.stringify(reply) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  console.warn = (...args: unknown[]) => { diagnosticLogs.push(args); };

  const queryOnly = await generateConversationReplyWithMemoryAssistant({
    chatInput,
    assistant: deepSeekAssistant,
    candidates: [],
    loadCandidates: async () => [candidate],
  });
  assert.equal(requests.length, 4, "A query-only first response should proceed through retrieval retry and final chat.");
  assert.equal(requests[0]?.body.max_tokens, 512, "Chat token settings must not be replaced by memory-assistant limits.");
  assert.equal(requests[1]?.body.max_tokens, 1_638);
  assert.equal(requests[2]?.body.max_tokens, 2_048,
    "A truncated retry must use the configured ceiling and never exceed it.");
  assert.equal(requests[3]?.body.max_tokens, 512, "The final chat call must keep the chat model's token limit.");
  assert.deepEqual(requests[1]?.body.thinking, { type: "disabled" },
    "DeepSeek memory lookups should explicitly disable unnecessary reasoning.");
  assert.deepEqual(requests[2]?.body.thinking, { type: "disabled" });
  assert.equal(queryOnly.reply, "你之前提到过喜欢《星际穿越》。");
  assert.equal(queryOnly.memoryAssistantStatus, "success");
  assert.equal(queryOnly.memoryAssistantAttempts, 2);
  assert.equal(queryOnly.memoryAssistantUsage?.totalTokens, 2_768,
    "Usage from the truncated attempt and successful retry should both be counted.");
  assert.equal(diagnosticLogs.some((entry) => String(entry[0]).includes("retry_truncated")), true);
  assert.equal(JSON.stringify(diagnosticLogs).includes("之前你说过的太空电影"), false,
    "Diagnostics must not copy the private search query into logs.");
} finally {
  globalThis.fetch = originalFetch;
  console.warn = originalWarn;
}

// A query-only first response must still produce a non-empty user-facing reply when lookup fails.
const failureLogs: unknown[][] = [];
const warnBeforeFailure = console.warn;
try {
  let mainCalls = 0;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.includes("memory.example.com")) {
      return new Response("unavailable", { status: 503 });
    }
    mainCalls += 1;
    return new Response(JSON.stringify({
      model: "chat-model",
      choices: [{ message: { content: JSON.stringify({ memoryAssistantQuery: "生日是哪一天？" }) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 80, completion_tokens: 10, total_tokens: 90 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  console.warn = (...args: unknown[]) => { failureLogs.push(args); };
  const failedQueryOnly = await generateConversationReplyWithMemoryAssistant({
    chatInput,
    assistant,
    candidates: [],
    loadCandidates: async () => [candidate],
  });
  assert.equal(mainCalls, 1);
  assert.equal(failedQueryOnly.reply, "本宝刚才想去翻以前的记录，但这次检索没成功，先不乱告诉你。",
    "A failed lookup must replace any first-pass placeholder such as 'let me search' with an honest result.");
  assert.equal(failedQueryOnly.memoryAssistantStatus, "failed");
  assert.equal(failedQueryOnly.memoryAssistantFailureReason, "http_error");
  assert.equal(failedQueryOnly.memoryAssistantHttpStatus, 503);
  assert.equal(failureLogs.length > 0, true);
  assert.equal(JSON.stringify(failureLogs).includes("生日是哪一天"), false,
    "Failure logs must not include the private search query.");
} finally {
  globalThis.fetch = originalFetch;
  console.warn = warnBeforeFailure;
}

// Empty candidate selection must not leave the user waiting for a lookup that has already ended.
const noSourceLogs: unknown[][] = [];
const warnBeforeNoSource = console.warn;
try {
  globalThis.fetch = async (input: RequestInfo | URL): Promise<Response> => {
    if (String(input).includes("memory.example.com")) {
      return new Response(JSON.stringify({
        model: "memory-model",
        choices: [{ message: { content: JSON.stringify({ sourceKeys: [] }) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 40, completion_tokens: 5, total_tokens: 45 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({
      model: "chat-model",
      choices: [{ message: { content: JSON.stringify({ reply: "让我去翻翻", memoryAssistantQuery: "查找角色生日", usedMemoryIds: [], usedSnapshotIds: [] }) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 70, completion_tokens: 10, total_tokens: 80 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  console.warn = (...args: unknown[]) => { noSourceLogs.push(args); };
  const noSources = await generateConversationReplyWithMemoryAssistant({
    chatInput,
    assistant,
    candidates: [],
    loadCandidates: async () => [candidate],
  });
  assert.equal(noSources.memoryAssistantStatus, "no_sources");
  assert.equal(noSources.reply, "本宝把目前能查到的记录翻了一遍，没有找到足够可靠的内容，暂时不能确定。");
  assert.equal(noSources.memoryAssistantUsage?.totalTokens, 45);
  assert.equal(noSourceLogs.some((entry) => String(entry[0]).includes("no_sources")), true);
} finally {
  globalThis.fetch = originalFetch;
  console.warn = warnBeforeNoSource;
}

// A first-pass answer backed by deterministic context must not be replaced by "no record"
// just because the long-term-memory tables have nothing (journal facts are not candidates).
try {
  globalThis.fetch = async (input: RequestInfo | URL): Promise<Response> => {
    if (String(input).includes("memory.example.com")) {
      return new Response(JSON.stringify({
        model: "memory-model",
        choices: [{ message: { content: JSON.stringify({ sourceKeys: [] }) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 40, completion_tokens: 5, total_tokens: 45 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({
      model: "chat-model",
      choices: [{ message: { content: JSON.stringify({ reply: "10月30号呀。", memoryAssistantQuery: "查找角色生日", usedMemoryIds: [], usedSnapshotIds: [] }) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 70, completion_tokens: 10, total_tokens: 80 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const contextAnswered = await generateConversationReplyWithMemoryAssistant({
    chatInput: { ...chatInput, journalFacts: [{ dayKey: "2026-11-02", text: "今天被定了生日，10月30号" }] },
    assistant,
    candidates: [],
    loadCandidates: async () => [candidate],
  });
  assert.equal(contextAnswered.memoryAssistantStatus, "context_answered");
  assert.equal(contextAnswered.reply, "10月30号呀。", "上下文里已有答案时，不能拿「没找到记录」把它盖掉");
} finally {
  globalThis.fetch = originalFetch;
}

// Connection test uses the assistant's own endpoint and credential, and accepts a configured assistant before activation.
const connectionCalls: Array<{ url: string; authorization: string; body: Record<string, unknown> }> = [];
const originalFetchForConnection = globalThis.fetch;
try {
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    connectionCalls.push({
      url: String(input),
      authorization: headers.get("authorization") ?? "",
      body,
    });
    return new Response(JSON.stringify({
      model: "memory-model",
      choices: [{ message: { content: "ok" } }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const connection = await testMemoryAssistantConnection(assistant);
  assert.equal(connection.ok, true);
  assert.equal(connection.model, "memory-model");
  assert.equal(connection.provider, "memory.example.com");
  assert.equal(connectionCalls.length, 1);
  assert.equal(connectionCalls[0]?.url, "https://memory.example.com/v1/chat/completions");
  assert.equal(connectionCalls[0]?.authorization, "Bearer memory-key-only");
  assert.equal(connectionCalls[0]?.body.model, "memory-model");
  assert.equal(connectionCalls[0]?.body.max_tokens, 16);

  globalThis.fetch = async (): Promise<Response> =>
    new Response("unauthorized", { status: 401 });
  const rejected = await testMemoryAssistantConnection(assistant);
  assert.equal(rejected.ok, false);
  assert.match(rejected.message, /API Key 无效/);
} finally {
  globalThis.fetch = originalFetchForConnection;
}

const budgetCandidates: MemoryAssistantCandidate[] = Array.from({ length: 12 }, (_, index) => ({
  sourceKey: `memory/budget-${index}`,
  sourceType: "memory" as const,
  id: `budget-${index}`,
  scope: "character" as const,
  relevanceScore: 12 - index,
  content: "历史资料".repeat(180),
}));
const budgetSystemPrompt = "你是只读历史记忆检索助手。";
const fittedBudgetCandidates = fitMemoryAssistantCandidates(
  budgetCandidates,
  "检索某个历史细节",
  4_096,
  budgetSystemPrompt,
);
const estimatedPayloadTokens = estimateMemoryAssistantTokens(JSON.stringify({
  query: "检索某个历史细节",
  candidates: fittedBudgetCandidates,
})) + estimateMemoryAssistantTokens(budgetSystemPrompt) + 256;
assert(fittedBudgetCandidates.length > 0);
assert(fittedBudgetCandidates.length < budgetCandidates.length,
  "The unified input budget must trim candidates instead of allowing per-category budgets to add up unchecked.");
assert(estimatedPayloadTokens <= 4_096,
  "Estimated prompt and candidate payload must stay within the configured input budget.");

console.log("Memory assistant tests passed: scope isolation, source whitelist, independent credentials, on-demand lookup, connection test, usage accounting, input budget, and output ceiling.");
