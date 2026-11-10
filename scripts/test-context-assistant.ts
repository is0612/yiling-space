import assert from "node:assert/strict";
import {
  analyzeGroupContext,
  ContextAssistantError,
  CONTEXT_ASSISTANT_DEFAULTS,
  resolveContextAssistantRuntime,
} from "../server/utils/context-assistant";
import type { ConversationReplyInput } from "../server/utils/chat-reply";
import type { MemoryAssistantRuntime } from "../server/utils/memory-assistant";

const runtime: MemoryAssistantRuntime = {
  model: "context-model", apiKey: "context-key-only", apiBaseUrl: "https://context.invalid/v1",
  ...CONTEXT_ASSISTANT_DEFAULTS,
};
const input: ConversationReplyInput = {
  groupChat: true, characterName: "小鱼", characterPrompt: "SECRET_PERSONA",
  apiKey: "SECRET_CHAT_KEY", apiBaseUrl: "https://secret-chat.invalid/v1",
  currentMessage: "@self 我在教另一只鱼：别人说‘退下’时可以先问为什么。这不是叫你退下。",
  now: new Date("2026-11-05T03:00:00Z"),
  transcript: [{ id: "current-1", member: "member_1", speaker: "群友", content: "@self 我在教另一只鱼：别人说‘退下’时可以先问为什么。这不是叫你退下。", isOwner: false, mentions: [{ qq: "999", target: "self" }] }],
  groupBackground: [{ id: "background-1", member: "member_2", content: "@member_3 这个声音好听", mentions: [{ qq: "123456789", target: "other", member: "member_3", speaker: "外部 bot", kind: "AI" }] }],
  groupMembers: [{ member: "member_2", speaker: "另一只鱼", belongsTo: "member_1", belongsToName: "群友" }],
  groupAnchors: [{ id: "anchor-only", label: "教学示例" }],
  recentMessages: [
    { role: "USER", content: "@member_3 这个声音好听", speaker: "群友", mentions: [{ qq: "123456789", target: "other", member: "member_3", speaker: "外部 bot", kind: "AI" }] },
    { role: "ASSISTANT", content: "那边在讨论教学。", occurredAt: "2026-11-05T02:59:00Z" },
  ],
  memories: [{ id: "private-memory", category: "FACT", content: "SECRET_PRIVATE_MEMORY", confidence: 1, relevanceScore: 1, scope: "private" }],
  snapshots: [{ id: "private-snapshot", summary: "SECRET_PRIVATE_SNAPSHOT", periodStart: "", periodEnd: "", version: 1, relevanceScore: 1, scope: "private" }],
  styleExamples: "SECRET_STYLE", userAddress: "SECRET_ADDRESS",
  speaker: { isOwner: true, ownerDisplayName: "SECRET_OWNER" },
  events: [{ id: "private-event", title: "SECRET_EVENT", detail: "SECRET_EVENT", participants: [], scope: "private", occurredAt: "" }],
  rawMessages: [{ id: "private-raw", role: "USER", content: "SECRET_RAW", occurredAt: "", scope: "private" }],
  journalLine: { dayKey: "", quote: "SECRET_JOURNAL" },
};
const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120,
  prompt_tokens_details: { cached_tokens: 40 }, completion_tokens_details: { reasoning_tokens: 8 } };
const valid = { summary: "群友正在讲给另一只鱼听的教学示例，引用退下并非让当前角色离开。", evidenceMessageIds: ["current-1"], participation: "observing" };
function modelResponse(content: unknown = valid, finishReason = "stop", withUsage = true): Response {
  return Response.json({ choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) }, finish_reason: finishReason }], ...(withUsage ? { usage } : {}) });
}
type RequestBody = { model: string; max_tokens: number; response_format: { type: string }; thinking?: { type: string }; reasoning_effort?: string; messages: Array<{ role: string; content: string }> };
type PublicBody = {
  characterName: string; currentTime: string; currentMessage: string; contextClipped: boolean;
  transcript: Array<{ id?: string; content: string; mentions?: Array<Record<string, unknown>>; [key: string]: unknown }>;
  groupBackground: Array<{ id?: string; content: string; mentions?: Array<Record<string, unknown>> }>;
  recentMessages: Array<{ id?: string; content: string; mentions?: Array<Record<string, unknown>> }>;
  groupMembers: unknown[]; groupAnchors: unknown[];
};
const originalFetch = globalThis.fetch;
let calls = 0;
/** 请求断言用的模型名：思考模型那一组要换成 DeepSeek 才走 `thinking` 分支。 */
let expectedModel = "context-model";
let requests: RequestBody[] = [];
let publicBodies: PublicBody[] = [];
let handler: () => Response | Promise<Response> = () => modelResponse();
globalThis.fetch = async (url, options) => {
  calls++;
  assert.equal(String(url), "https://context.invalid/v1/chat/completions");
  assert.equal(options?.redirect, "error");
  assert.equal(options?.method, "POST");
  assert(options?.signal instanceof AbortSignal);
  const headers = options?.headers as Record<string, string>;
  assert.equal(headers.authorization, "Bearer context-key-only");
  const body = JSON.parse(String(options?.body)) as RequestBody;
  requests.push(body);
  assert.equal(body.response_format.type, "json_object");
  assert.equal(body.model, expectedModel);
  assert.deepEqual(body.messages.map(row => row.role), ["system", "user"]);
  assert(!JSON.stringify(body.messages).includes("SECRET_"), "Private fields and secrets must never enter either prompt.");
  publicBodies.push(JSON.parse(body.messages[1]!.content) as PublicBody);
  return handler();
};
function reset(next: () => Response | Promise<Response> = () => modelResponse()) {
  calls = 0; requests = []; publicBodies = []; handler = next;
}
async function safeFailure(operation: () => Promise<unknown>, totalTokens?: number) {
  await assert.rejects(operation, (error: unknown) => {
    assert(error instanceof ContextAssistantError);
    assert.equal(error.message, "Context assistant analysis unavailable.");
    assert.equal(error.usage?.totalTokens, totalTokens);
    assert(!("cause" in error));
    return true;
  });
}

try {
  assert.deepEqual(CONTEXT_ASSISTANT_DEFAULTS, { temperature: 0.1, maxInputTokens: 16_384, maxOutputTokens: 2_048 });
  for (const config of [undefined, {}, { contextAssistantEnabled: false, contextAssistantModel: "unused" },
    { contextAssistantEnabled: true },
    { contextAssistantEnabled: true, contextAssistantModel: "context-model", chatApiKeyEncrypted: "v1.invalid", memoryAssistantApiKeyEncrypted: "v1.invalid" },
    { contextAssistantEnabled: true, contextAssistantModel: "context-model", contextAssistantApiBaseUrl: "invalid" },
    { contextAssistantEnabled: true, contextAssistantModel: "context-model", contextAssistantApiKeyEncrypted: "v1.invalid" }]) {
    assert.equal(await resolveContextAssistantRuntime(config, "https://context.invalid/v1"), null,
      "Disabled/incomplete/broken independent configuration must fail closed without fallback.");
  }
  assert.equal(calls, 0);
  await safeFailure(() => analyzeGroupContext(runtime, { ...input, groupChat: false }));
  assert.equal(calls, 0, "Private inputs must be rejected before fetch.");

  reset();
  const result = await analyzeGroupContext(runtime, input);
  assert.equal(calls, 1);
  assert.deepEqual(result.analysis, valid);
  assert.equal(result.usage?.totalTokens, 120);
  assert.equal(result.usage?.reasoningTokens, 8);
  assert.equal(result.usage?.cacheHitTokens, 40);
  assert.equal(publicBodies[0]?.currentTime, "2026-11-05T03:00:00.000Z");
  assert.deepEqual(Object.keys(publicBodies[0]!).sort(), ["characterName", "currentTime", "currentMessage", "contextClipped", "transcript", "groupBackground", "recentMessages", "groupMembers", "groupAnchors"].sort());
  assert.deepEqual(publicBodies[0]?.transcript[0]?.mentions, [{ target: "self" }], "语境助手也要知道这一行 @ 的是她本人。");
  assert.deepEqual(
    publicBodies[0]?.groupBackground[0]?.mentions,
    [{ target: "other", member: "member_3", speaker: "外部 bot", kind: "AI" }],
    "背景里的 @ 对象要带身份；只给 @member_3 分不清是另一个 bot 还是她。",
  );
  assert(!JSON.stringify(publicBodies[0]).includes("123456789"), "被 @ 对象的真实账号不能进语境助手提示词。");
  assert.deepEqual(
    publicBodies[0]?.recentMessages[0]?.mentions,
    [{ target: "other", member: "member_3", speaker: "外部 bot", kind: "AI" }],
    "最近对话里的 USER 行也要带 @ 对象；否则历史里的 @ 仍会被读成在说她。",
  );
  assert.match(requests[0]!.messages[0]!.content, /target other is another member or bot/u, "系统提示词必须说明 @other 不是她。");
  assert.match(requests[0]!.messages[0]!.content, /teaching/);
  assert.match(requests[0]!.messages[0]!.content, /退下/);
  // This only proves mocked output passes through validation and the instruction is present.
  // It does not establish a real model's ability to understand quoted Chinese commands.

  for (const content of ["```json\n" + JSON.stringify(valid) + "\n```", "好的，分析如下：" + JSON.stringify(valid) + " 完毕。"] ) {
    reset(() => modelResponse(content));
    assert.deepEqual((await analyzeGroupContext(runtime, input)).analysis, valid,
      "Loose parsing must rescue fenced/prefixed objects containing an evidence array.");
  }
  reset(() => modelResponse({ ...valid, evidenceMessageIds: ["fake", "anchor-only", "private-memory", "current-1", "current-1", "background-1", 123],
    action: "send", reply: "IGNORE_SCHEMA", writeMemory: true, nested: { apiKey: "secret" } }));
  const sanitized = (await analyzeGroupContext(runtime, input)).analysis;
  assert.deepEqual(sanitized.evidenceMessageIds, ["current-1", "background-1"]);
  assert.deepEqual(Object.keys(sanitized).sort(), ["summary", "evidenceMessageIds", "participation"].sort());

  reset(() => modelResponse({ ...valid, knowledgeCandidate: {
    evidenceMessageIds: ["background-1", "fake", "current-1", "anchor-only", "current-1", 123],
    reason: "群聊里出现了可复用的解释。",
  } }));
  const knowledge = (await analyzeGroupContext(runtime, input)).analysis.knowledgeCandidate;
  assert.deepEqual(knowledge, {
    evidenceMessageIds: ["background-1", "current-1"],
    reason: "群聊里出现了可复用的解释。",
  }, "Knowledge candidate evidence must be restricted to actual included source messages.");
  reset(() => modelResponse({ ...valid, knowledgeCandidate: { evidenceMessageIds: ["fake"], reason: "invented" } }));
  assert.equal((await analyzeGroupContext(runtime, input)).analysis.knowledgeCandidate, undefined);

  for (const participation of ["observing", "invited", "ADMIN_OVERRIDE"]) {
    reset(() => modelResponse({ ...valid, participation, evidenceMessageIds: ["hallucinated"] }));
    assert.equal((await analyzeGroupContext(runtime, input)).analysis.participation, "uncertain");
  }
  reset(() => modelResponse({ ...valid, participation: "invited", evidenceMessageIds: ["current-1"] }));
  assert.equal((await analyzeGroupContext(runtime, input)).analysis.participation, "invited");
  reset(() => modelResponse({ ...valid, summary: "摘".repeat(3_000), memoryQuery: "问".repeat(800), knowledgeQuery: "知".repeat(800), uncertainty: "疑".repeat(900) }));
  const bounded = (await analyzeGroupContext(runtime, input)).analysis;
  assert.equal(bounded.summary.length, 1_600);
  assert.equal(bounded.memoryQuery?.length, 240);
  assert.equal(bounded.knowledgeQuery?.length, 240);
  assert.equal(bounded.uncertainty?.length, 400);
  for (const content of ["not JSON SECRET_PROVIDER_BODY", "[]", "null", "{}", '{"summary":42}', '[{"summary":"bad"}]']) {
    reset(() => modelResponse(content));
    await safeFailure(() => analyzeGroupContext(runtime, input), 120);
    assert.equal(calls, 1, "Invalid JSON/schema must not trigger a retry.");
  }
  reset(() => Response.json({ choices: [{ message: {}, finish_reason: "stop" }], usage }));
  await safeFailure(() => analyzeGroupContext(runtime, input), 120);
  reset(() => new Response("SECRET_PROVIDER_BODY", { status: 401 }));
  await safeFailure(() => analyzeGroupContext(runtime, input));
  assert.equal(calls, 1);
  reset(() => new Response("not JSON", { status: 200 }));
  await safeFailure(() => analyzeGroupContext(runtime, input));
  reset(() => { throw new Error("SECRET_NETWORK_KEY"); });
  await safeFailure(() => analyzeGroupContext(runtime, input));

  reset(() => calls === 1 ? modelResponse("", "length") : modelResponse());
  const retried = await analyzeGroupContext(runtime, input);
  assert.deepEqual(requests.map(row => row.max_tokens), [2_048, 4_096]);
  assert.equal(retried.usage?.totalTokens, 240);
  assert.equal(retried.usage?.reasoningTokens, 16);
  assert.equal(retried.usage?.cacheHitTokens, 80);
  reset(() => modelResponse("", "length"));
  await safeFailure(() => analyzeGroupContext({ ...runtime, maxOutputTokens: 6_000 }, input), 240);
  assert.deepEqual(requests.map(row => row.max_tokens), [6_000, 8_192]);
  reset(() => modelResponse("", "length"));
  await safeFailure(() => analyzeGroupContext({ ...runtime, maxOutputTokens: 8_192 }, input), 120);
  assert.equal(calls, 1);
  /**
   * 思考模型：`max_tokens` 是「思考 + 正文」的总预算，配置值只表达**可见**预算。
   * 两者混为一谈时，2048 会在思考阶段就被吃空、正文为空，只能整包重发。
   */
  expectedModel = "deepseek-flash";
  reset(() => modelResponse());
  await analyzeGroupContext({ ...runtime, model: "deepseek-flash" }, input);
  assert.equal(requests[0]!.max_tokens, 6_144, "DeepSeek 必须为思考留出余量，否则正文一个字都写不出来。");
  assert.deepEqual(requests[0]!.thinking, { type: "enabled" });
  assert.equal(requests[0]!.reasoning_effort, "low", "语境助手只需读懂，不需要高强度思维链。");
  reset(() => modelResponse());
  expectedModel = "context-model";
  await analyzeGroupContext(runtime, input);
  assert(!("thinking" in requests[0]!), "认不出是 DeepSeek 就整段不发，避免 OpenAI 接口 400。");
  assert.equal(requests[0]!.max_tokens, CONTEXT_ASSISTANT_DEFAULTS.maxOutputTokens, "非思考模型不加余量。");
  reset(() => calls === 1 ? modelResponse("", "length") : new Response("SECRET_SECOND_FAILURE", { status: 500 }));
  await safeFailure(() => analyzeGroupContext(runtime, input), 120);
  reset(() => modelResponse(valid, "stop", false));
  assert.equal((await analyzeGroupContext(runtime, input)).usage, undefined);

  const longInput: ConversationReplyInput = {
    ...input,
    currentMessage: "CURRENT_PRIORITY_" + "长".repeat(40_000),
    transcript: Array.from({ length: 20 }, (_, i) => ({ id: "round-" + i, content: "CURRENT_ROUND_" + i + "长".repeat(5_000), speaker: "群友" })),
    groupBackground: Array.from({ length: 80 }, (_, i) => ({ id: "old-" + i, content: "BACKGROUND_" + "长".repeat(20_000) })),
    recentMessages: Array.from({ length: 80 }, () => ({ role: "USER" as const, content: "RECENT_" + "长".repeat(20_000), occurredAt: "" })),
  };
  reset(() => modelResponse({ ...valid, evidenceMessageIds: ["old-0", "round-19"] }));
  const smallRuntime = { ...runtime, maxInputTokens: 4_096 };
  const budgetResult = await analyzeGroupContext(smallRuntime, longInput);
  const selected = publicBodies[0]!;
  assert.equal(selected.contextClipped, true);
  assert(selected.currentMessage.startsWith("CURRENT_PRIORITY_"));
  assert(selected.transcript.some(row => row.id === "round-19"), "Newest current round must survive a tight budget.");
  assert(!budgetResult.analysis.evidenceMessageIds.includes("old-0"), "Omitted background ids are not evidence.");
  assert(Buffer.byteLength(requests[0]!.messages.map(row => row.content).join(""), "utf8") + 256 <= 4_096,
    "Entire serialized prompt including system and reserve must remain within budget.");
  reset(() => modelResponse({ ...valid, workingSummary: "群友与小鱼约好稍后继续聊天。", workingEvidenceMessageIds: ["saved", "invented"] }));
  const carried = await analyzeGroupContext(runtime, input, { summary: "稍后继续聊天。", evidence: [{ id: "saved", role: "ASSISTANT", content: "晚点继续聊。", occurredAt: "2026-11-05T02:40:00Z" }] });
  assert.deepEqual(carried.analysis.workingEvidenceMessageIds, ["saved"]);
  assert(JSON.stringify(publicBodies[0]).includes("晚点继续聊。"), "Original stored evidence survives into the next analysis.");
  reset(() => modelResponse({ ...valid, workingSummary: "member_2答应了", workingEvidenceMessageIds: ["current-1"] }));
  assert.equal((await analyzeGroupContext(runtime, input)).analysis.workingSummary, "", "Do not persist process-local member aliases.");
  reset();
  await analyzeGroupContext(smallRuntime, longInput);
  const firstBody = JSON.stringify(publicBodies[0]);
  reset();
  await analyzeGroupContext(smallRuntime, longInput);
  assert.equal(JSON.stringify(publicBodies[0]), firstBody, "Clipping/selection must be deterministic.");
  reset();
  await safeFailure(() => analyzeGroupContext({ ...runtime, maxInputTokens: 1 }, input));
  assert.equal(calls, 0);

  // Unknown nested input properties must not hitchhike through object spreads.
  const injected = structuredClone(input);
  Object.assign(injected.transcript![0]!, { apiKey: "SECRET_NESTED_KEY", privateMemory: "SECRET_NESTED_MEMORY" });
  Object.assign(injected.groupMembers![0]!, { note: "SECRET_MEMBER_NOTE" });
  Object.assign(injected.groupAnchors![0]!, { instruction: "SECRET_ANCHOR_INJECTION" });
  Object.assign(injected, { basePrompt: "SECRET_BASE_PROMPT", contextAnalysis: { summary: "SECRET_PREVIOUS_ANALYSIS" } });
  reset();
  await analyzeGroupContext(runtime, injected);
  assert.equal(calls, 1);
  console.log("Context assistant mocked tests passed (no real model calls; semantic quality not measured).");
} finally {
  globalThis.fetch = originalFetch;
}
