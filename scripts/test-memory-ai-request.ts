import assert from "node:assert/strict";
import { analyzeMemoryPeriod, resolveMemoryOutputBudget, type MemoryAiCallDiagnostics } from "../server/utils/memory-ai";

const originalFetch = globalThis.fetch;
const originalEnv = {
  apiKey: process.env.LLM_API_KEY,
  baseUrl: process.env.LLM_BASE_URL,
  model: process.env.LLM_MODEL,
  jobTimeout: process.env.LLM_JOB_TIMEOUT_MS,
  outputCap: process.env.LLM_MEMORY_MAX_OUTPUT_TOKENS,
};
const secretApiKey = "sk-memory-test-secret-must-not-appear-in-body";
const privateProviderUrl = "https://private-memory-provider.example/v1";
let capturedUrl = "";
let capturedHeaders: Headers | null = null;
let capturedBody = "";
let fetchCalls = 0;

const analysis = {
  summary: "本周期测试摘要。",
  importantEvents: [],
  factAndPreferenceChanges: [],
  relationshipChanges: [],
  goalsAndCommitments: [],
  unresolvedTopics: [],
  differencesFromPrevious: [],
  memoryChanges: [],
};

globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  fetchCalls += 1;
  capturedUrl = String(input);
  capturedHeaders = new Headers(init?.headers);
  capturedBody = typeof init?.body === "string" ? init.body : "";
  return new Response(JSON.stringify({
    choices: [{ message: { role: "assistant", content: JSON.stringify(analysis) } }],
    usage: { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16 },
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

const input = {
  apiKey: secretApiKey,
  apiBaseUrl: privateProviderUrl,
  model: "test-memory-model",
  periodStart: "2026-10-01T00:00:00.000Z",
  periodEnd: "2026-10-09T00:00:00.000Z",
  timezone: "America/Los_Angeles",
  scopeType: "CHARACTER",
  characterName: "测试角色",
  messages: [{
    id: "message-1",
    role: "USER",
    eventType: "message",
    occurredAt: "2026-10-04T10:00:00.000Z",
    content: "我喜欢星空。",
    origin: "QQ群 12345678",
    isOwner: true,
  }, {
    id: "message-2",
    role: "USER",
    eventType: "message",
    occurredAt: "2026-10-04T10:01:00.000Z",
    content: "@123456789 这个声音好听，比较像你",
    origin: "QQ群 12345678",
    isOwner: true,
    mentionTargets: ["other"],
    mentions: [{ qq: "123456789", target: "other", member: "member_2", speaker: "外部 bot", kind: "AI" }],
  }],
  totalMessageCount: 2,
  omittedMessageCount: 0,
  activeMemories: [{
    id: "memory-1",
    category: "PREFERENCE" as const,
    content: "用户喜欢星空。",
    confidence: 0.95,
    validFrom: "2026-10-04T10:00:00.000Z",
    validTo: null,
    createdAt: "2026-10-04T10:00:00.000Z",
  }],
  previousSnapshotSummary: "之前讨论过观星。",
};

try {
  delete process.env.LLM_MEMORY_MAX_OUTPUT_TOKENS;
  const result = await analyzeMemoryPeriod(input);

  assert.equal(capturedUrl, privateProviderUrl + "/chat/completions");
  assert.equal(capturedHeaders?.get("authorization"), "Bearer " + secretApiKey);
  assert(capturedBody.length > 0, "The provider request body should be captured.");
  assert(!capturedBody.includes(secretApiKey), "The API key must only be sent in the Authorization header.");
  assert(!capturedBody.includes(privateProviderUrl), "The provider URL must not be serialized into the model request body.");

  const requestBody = JSON.parse(capturedBody) as {
    model: string;
    messages: Array<{ role: string; content: string }>;
  };
  assert.equal(requestBody.model, "test-memory-model");
  const userMessage = requestBody.messages.find((message) => message.role === "user");
  assert(userMessage, "A structured memory-evidence prompt must be sent.");
  const promptInput = JSON.parse(userMessage.content) as Record<string, unknown>;
  assert.deepEqual(
    Object.keys(promptInput).sort(),
    [
      "periodStart", "periodEnd", "timezone", "scopeType", "characterName",
      "messages", "totalMessageCount", "omittedMessageCount", "activeMemories",
      "previousSnapshotSummary",
    ].sort(),
    "Only explicit memory-analysis fields should be serialized into the prompt.",
  );
  const promptMessages = promptInput.messages as Array<Record<string, unknown>>;
  assert.equal(promptMessages[0]?.origin, "QQ群 12345678", "群号来源必须进提示词，否则模型分不清是哪段关系在说话。");
  assert.equal(promptMessages[0]?.isOwner, true, "主人标记必须进提示词，否则提炼时分不清主人和群友。");
  assert.deepEqual(
    promptMessages[1]?.mentions,
    [{ target: "other", member: "member_2", speaker: "外部 bot", kind: "AI" }],
    "@ 对象必须带代号 / 显示名 / 身份；真实 QQ 不进记忆提示词。",
  );
  assert.equal(
    promptMessages[1]?.content,
    "@member_2 这个声音好听，比较像你",
    "正文里的真实 QQ 要按结构化 mentions 换成 @member_n。",
  );
  assert(!JSON.stringify(promptMessages[1]).includes("123456789"), "真实账号只留在进程内。");
  const systemMessage = requestBody.messages.find((message) => message.role === "system");
  assert(systemMessage?.content.includes("群聊"), "系统提示词必须写明群聊的提炼边界。");
  assert(systemMessage?.content.includes("主人"), "系统提示词必须写明主人识别的规则。");
  assert(systemMessage?.content.includes("RELATIONSHIP"), "系统提示词必须写明关系记忆的规则。");
  assert.match(systemMessage?.content ?? "", /target=other/u, "系统提示词必须解释 mentions.target=other 不是她。");
  assert.match(systemMessage?.content ?? "", /不要把别人被叫的称呼/u, "系统提示词必须禁止把 @other 的称呼记成她的。");
  assert.equal(result.analysis.summary, "本周期测试摘要。");
  assert.equal(result.usage?.totalTokens, 16);

  // 主人私聊：全局记忆要进请求，并明确允许把「关于她本人」的事实写进全局。
  await analyzeMemoryPeriod({
    ...input,
    globalMemories: [{
      id: "global-1",
      category: "FACT" as const,
      content: "她只会发文字，没有语音功能。",
      confidence: 0.9,
      validFrom: "2026-10-01T00:00:00.000Z",
      validTo: null,
      createdAt: "2026-10-01T00:00:00.000Z",
    }],
    allowGlobalMemory: true,
  });
  const globalRequestBody = JSON.parse(capturedBody) as { messages: Array<{ role: string; content: string }> };
  const globalUserMessage = globalRequestBody.messages.find((message) => message.role === "user");
  const globalPromptInput = JSON.parse(globalUserMessage!.content) as Record<string, unknown>;
  assert.ok(Array.isArray(globalPromptInput.globalMemories), "globalMemories 必须进请求体。");
  assert.equal((globalPromptInput.globalMemories as Array<Record<string, unknown>>)[0]?.id, "global-1");
  const globalSystemMessage = globalRequestBody.messages.find((message) => message.role === "system");
  assert.match(globalSystemMessage?.content ?? "", /scope: "character"/u, "系统提示词必须说明如何写进全局。");
  assert.match(globalSystemMessage?.content ?? "", /INVALIDATE/u, "系统提示词必须说明可以废掉旧的全局记忆。");

  // A global environment key must not be silently reused when a per-character
  // provider is selected but the caller did not resolve a matching credential.
  process.env.LLM_API_KEY = "global-fallback-key-must-not-be-used";
  process.env.LLM_BASE_URL = "https://global-provider.example/v1";
  const callsBeforeMissingKeyTest = fetchCalls;
  await assert.rejects(
    analyzeMemoryPeriod({ ...input, apiKey: "" }),
    /LLM_NOT_CONFIGURED/,
    "Missing API keys must fail closed rather than using the global key.",
  );
  await assert.rejects(
    analyzeMemoryPeriod({ ...input, apiBaseUrl: "" }),
    /LLM_NOT_CONFIGURED/,
    "Missing provider URLs must not silently fall back to the environment default.",
  );
  await assert.rejects(
    analyzeMemoryPeriod({ ...input, model: "" }),
    /LLM_NOT_CONFIGURED/,
    "Missing model names must not silently fall back to the environment default.",
  );
  assert.equal(fetchCalls, callsBeforeMissingKeyTest, "No network request should be made when resolved connection settings are missing.");

  const privateModelText = "private-model-output-must-not-leak";
  const diagnosticInput = {
    ...input,
    contextMessages: [{ ...input.messages[0]!, id: "context-1", content: "private-context-must-not-leak" }],
  };
  const expectedChars = [...diagnosticInput.messages, ...diagnosticInput.contextMessages]
    .reduce((total, message) => total + message.content.length, 0);
  function assertSafeError(error: unknown, code: string, finishReason?: string): boolean {
    assert(error instanceof Error);
    assert.match(error.message, new RegExp(`^${code}:`));
    assert(error.message.includes("inputMessages=3"));
    assert(error.message.includes(`inputChars=${expectedChars}`));
    if (finishReason) assert(error.message.includes(`finishReason=${finishReason}`));
    for (const secret of [secretApiKey, privateProviderUrl, privateModelText,
      ...diagnosticInput.messages.map((message) => message.content), diagnosticInput.contextMessages[0]!.content]) {
      assert(!error.message.includes(secret), "Diagnostics must not contain credentials or message/model text.");
    }
    return true;
  }
  const respond = (content: unknown, finishReason: unknown = "stop") => {
    globalThis.fetch = async () => new Response(JSON.stringify({
      choices: [{ finish_reason: finishReason, message: { content } }],
    }));
  };
  for (const content of ["", privateModelText, JSON.stringify(analysis)]) {
    respond(content, "length");
    await assert.rejects(analyzeMemoryPeriod(diagnosticInput),
      (error) => assertSafeError(error, "LLM_OUTPUT_TRUNCATED", "length"));
  }
  for (const content of ["", " \n\t", null, undefined]) {
    respond(content);
    await assert.rejects(analyzeMemoryPeriod(diagnosticInput),
      (error) => assertSafeError(error, "LLM_EMPTY_REPLY", "stop"));
  }
  for (const finishReason of ["stop", privateModelText, "stop\n" + secretApiKey, "x".repeat(10_000), null]) {
    respond(privateModelText, finishReason);
    await assert.rejects(analyzeMemoryPeriod(diagnosticInput),
      (error) => assertSafeError(error, "LLM_INVALID_JSON", finishReason === "stop" ? "stop" : "unknown"));
  }
  for (const envelope of ["not-json-" + privateModelText, "null", "[]"]) {
    globalThis.fetch = async () => new Response(envelope);
    await assert.rejects(analyzeMemoryPeriod(diagnosticInput),
      (error) => assertSafeError(error, "LLM_INVALID_ENVELOPE", "unknown"));
  }
  respond("```json\n" + JSON.stringify(analysis) + "\n```");
  assert.equal((await analyzeMemoryPeriod(diagnosticInput)).analysis.summary, analysis.summary);

  // Mock timers preserve the configured 5-second diagnostic while firing quickly.
  // Fetch and body deliberately ignore abort: the timeout must bound both phases itself.
  process.env.LLM_JOB_TIMEOUT_MS = "5000";
  const originalSetTimeout = globalThis.setTimeout;
  try {
    globalThis.setTimeout = ((callback: (...args: unknown[]) => void, _delay?: number, ...args: unknown[]) =>
      originalSetTimeout(callback, 10, ...args)) as typeof setTimeout;
    for (const phase of ["fetch", "body"] as const) {
      let signal: AbortSignal | null | undefined;
      let bodyStarted = false;
      globalThis.fetch = async (_url, init) => {
        signal = init?.signal;
        if (phase === "fetch") return new Promise<Response>(() => {});
        const response = new Response("");
        response.text = async () => {
          bodyStarted = true;
          return new Promise<string>(() => {});
        };
        return response;
      };
      const timeoutDiagnostics: MemoryAiCallDiagnostics[] = [];
      await assert.rejects(analyzeMemoryPeriod({ ...diagnosticInput, onDiagnostics: d => { timeoutDiagnostics.push(d); } }), (error) => {
        assertSafeError(error, "LLM_TIMEOUT");
        assert.match((error as Error).message, /5 秒/u);
        return true;
      });
      assert.equal(timeoutDiagnostics.length, 1);
      assert.equal(timeoutDiagnostics[0]?.status, "failed");
      assert.equal(timeoutDiagnostics[0]?.finishReason, "unknown");
      assert.equal(signal?.aborted, true, "Timeout must abort the provider request.");
      assert.equal(bodyStarted, phase === "body");
    }
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }

  const diagnostics: MemoryAiCallDiagnostics[] = [];
  for (const [cap, retry, expected] of [
    [undefined, false, 16_000], [undefined, true, 32_000],
    ["20000", true, 20_000], ["90000", true, 32_000],
    ["8000", false, 8_000], ["-1", true, 32_000], ["NaN", false, 16_000],
  ] as const) {
    if (cap === undefined) delete process.env.LLM_MEMORY_MAX_OUTPUT_TOKENS;
    else process.env.LLM_MEMORY_MAX_OUTPUT_TOKENS = cap;
    assert.equal(resolveMemoryOutputBudget(retry), expected);
    let calls = 0;
    globalThis.fetch = async (_url, init) => {
      calls++;
      assert.equal(JSON.parse(String(init?.body)).max_tokens, expected);
      assert(!String(init?.body).includes("previousOutputTruncated"));
      return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(analysis) } }],
        usage: { prompt_tokens: 15, completion_tokens: 10, total_tokens: 25, completion_tokens_details: { reasoning_tokens: 7 } } }));
    };
    await analyzeMemoryPeriod({ ...diagnosticInput, previousOutputTruncated: retry, onDiagnostics: d => { diagnostics.push(d); } });
    assert.equal(calls, 1, "One invocation never performs hidden HTTP retries.");
    const d = diagnostics.at(-1)!;
    assert.equal(d.outputBudget, expected); assert.equal(d.status, "success");
    assert.equal(d.finishReason, "stop"); assert.equal(d.usage?.reasoningTokens, 7);
    assert.equal(d.inputChars, expectedChars); assert(d.durationMs >= 0);
  }
  delete process.env.LLM_MEMORY_MAX_OUTPUT_TOKENS;
  for (const failure of ["length", "invalid", "network"] as const) {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      if (failure === "network") throw new Error(secretApiKey + privateModelText);
      return new Response(JSON.stringify({ choices: [{ finish_reason: failure === "length" ? "length" : "stop",
        message: { content: privateModelText } }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } }));
    };
    const before = diagnostics.length;
    await assert.rejects(analyzeMemoryPeriod({ ...diagnosticInput, onDiagnostics: d => { diagnostics.push(d); } }), error => {
      assertSafeError(error, failure === "length" ? "LLM_OUTPUT_TRUNCATED" : failure === "invalid" ? "LLM_INVALID_JSON" : "LLM_REQUEST_FAILED");
      assert.equal((error as Error & { outputBudget: number }).outputBudget, 16_000);
      return true;
    });
    assert.equal(calls, 1); assert.equal(diagnostics.length, before + 1);
    assert.equal(diagnostics.at(-1)!.status, "failed");
  }
  respond(JSON.stringify(analysis));
  await analyzeMemoryPeriod({ ...input, onDiagnostics: async () => { throw new Error("observer failed"); } });
  const diagnosticText = JSON.stringify(diagnostics);
  for (const secret of [secretApiKey, privateProviderUrl, privateModelText, diagnosticInput.contextMessages[0]!.content]) {
    assert(!diagnosticText.includes(secret), "Diagnostic callback contains only safe metadata.");
  }
  console.log("Memory AI request tests passed: credential isolation, prompt allow-list, timeout through response body, safe truncation/empty/JSON diagnostics, and fenced JSON.");
} finally {
  globalThis.fetch = originalFetch;
  if (originalEnv.apiKey === undefined) delete process.env.LLM_API_KEY;
  else process.env.LLM_API_KEY = originalEnv.apiKey;
  if (originalEnv.baseUrl === undefined) delete process.env.LLM_BASE_URL;
  else process.env.LLM_BASE_URL = originalEnv.baseUrl;
  if (originalEnv.model === undefined) delete process.env.LLM_MODEL;
  else process.env.LLM_MODEL = originalEnv.model;
  if (originalEnv.jobTimeout === undefined) delete process.env.LLM_JOB_TIMEOUT_MS;
  else process.env.LLM_JOB_TIMEOUT_MS = originalEnv.jobTimeout;
  if (originalEnv.outputCap === undefined) delete process.env.LLM_MEMORY_MAX_OUTPUT_TOKENS;
  else process.env.LLM_MEMORY_MAX_OUTPUT_TOKENS = originalEnv.outputCap;
}
