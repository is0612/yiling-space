import assert from "node:assert/strict";
import { analyzeMemoryPeriod } from "../server/utils/memory-ai";

const originalFetch = globalThis.fetch;
const originalEnv = {
  apiKey: process.env.LLM_API_KEY,
  baseUrl: process.env.LLM_BASE_URL,
  model: process.env.LLM_MODEL,
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
  }],
  totalMessageCount: 1,
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
  const systemMessage = requestBody.messages.find((message) => message.role === "system");
  assert(systemMessage?.content.includes("群聊"), "系统提示词必须写明群聊的提炼边界。");
  assert(systemMessage?.content.includes("主人"), "系统提示词必须写明主人识别的规则。");
  assert(systemMessage?.content.includes("RELATIONSHIP"), "系统提示词必须写明关系记忆的规则。");
  assert.equal(result.analysis.summary, "本周期测试摘要。");
  assert.equal(result.usage?.totalTokens, 16);

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

  console.log("Memory AI request tests passed: credential isolation, prompt allow-list, and fail-closed provider-key handling.");
} finally {
  globalThis.fetch = originalFetch;
  if (originalEnv.apiKey === undefined) delete process.env.LLM_API_KEY;
  else process.env.LLM_API_KEY = originalEnv.apiKey;
  if (originalEnv.baseUrl === undefined) delete process.env.LLM_BASE_URL;
  else process.env.LLM_BASE_URL = originalEnv.baseUrl;
  if (originalEnv.model === undefined) delete process.env.LLM_MODEL;
  else process.env.LLM_MODEL = originalEnv.model;
}
