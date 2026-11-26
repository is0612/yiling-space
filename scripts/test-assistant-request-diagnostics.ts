import assert from "node:assert/strict";
import { startAssistantRequest, type AssistantRequestDiagnostic } from "../server/utils/assistant-request-diagnostics";
import { generateConversationReply } from "../server/utils/chat-reply";
import { analyzeGroupContext } from "../server/utils/context-assistant";
import { callMemoryAssistant } from "../server/utils/memory-assistant";
const events: AssistantRequestDiagnostic[] = [];
const request = startAssistantRequest(entry => events.push(entry));
request.complete("invalid_response", { choices: [{ finish_reason: "length" }], usage: { total_tokens: 0 }, secret: "must-not-copy" });
request.complete("success");
assert.equal(events.length, 1); assert.equal(events[0]!.status, "truncated"); assert.equal(events[0]!.usageReported, true);
assert(!JSON.stringify(events).includes("secret"));
startAssistantRequest(() => { throw Error("diagnostic failure"); }).complete("success");
const originalFetch = globalThis.fetch;
const input = { characterName: "测试角色", characterPrompt: "自然说话", model: "test", apiKey: "secret", apiBaseUrl: "https://mock.example/v1", currentMessage: "你好", recentMessages: [], memories: [], snapshots: [], thinking: false };
function response(content: string, withUsage = true) { return Response.json({ choices: [{ message: { content }, finish_reason: "stop" }], ...(withUsage ? { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } } : {}) }); }
try {
  let calls = 0; events.length = 0;
  globalThis.fetch = async () => { calls++; return calls === 1 ? response("invalid-json") : response('{"reply":"你好","usedMemoryIds":[],"usedSnapshotIds":[]}'); };
  assert.equal((await generateConversationReply(input, entry => events.push(entry))).reply, "你好");
  assert.deepEqual(events.map(entry => entry.status), ["invalid_response", "success"]); assert(events.every(entry => entry.usageReported));
  calls = 0; events.length = 0;
  globalThis.fetch = async () => { calls++; return calls === 1 ? new Response("provider-secret", { status: 400 }) : response('{"reply":"你好"}', false); };
  await generateConversationReply({ ...input, model: "deepseek-test" }, entry => events.push(entry));
  assert.deepEqual(events.map(entry => entry.status), ["http_error", "success"]);
  assert.equal(events[1]!.usageReported, false);
  events.length = 0;
  globalThis.fetch = async () => { const error = Error("simulated timeout"); error.name = "TimeoutError"; throw error; };
  await assert.rejects(generateConversationReply(input, entry => events.push(entry)), /LLM_TIMEOUT/);
  assert.deepEqual(events.map(entry => entry.status), ["timeout"]);
  calls = 0; events.length = 0;
  const runtime = { model: "mock", apiKey: "secret", apiBaseUrl: "https://mock.example/v1", temperature: 0.1, maxInputTokens: 16384, maxOutputTokens: 2048 };
  globalThis.fetch = async () => { calls++; return calls === 1 ? Response.json({ choices: [{ finish_reason: "length", message: { content: "" } }], usage: { completion_tokens: 2048 } }) : response('{"summary":"本轮是问候","participation":"invited","evidenceMessageIds":["current"]}'); };
  await analyzeGroupContext(runtime, { ...input, groupChat: true, transcript: [{ id: "current", content: "你好" }] }, undefined, entry => events.push(entry));
  assert.deepEqual(events.map(entry => entry.status), ["truncated", "success"]);
  calls = 0; events.length = 0;
  globalThis.fetch = async () => { calls++; return calls === 1 ? Response.json({ choices: [{ finish_reason: "length", message: { content: "" } }], usage: { completion_tokens: 1024 } }) : response('{"sourceKeys":["memory/public"]}'); };
  await callMemoryAssistant(runtime, "公开经历", [{ id: "public", sourceKey: "memory/public", sourceType: "memory", scope: "character", content: "有来源", relevanceScore: 1 }], entry => events.push(entry));
  assert.deepEqual(events.map(entry => entry.status), ["truncated", "success"]);
  globalThis.fetch = async () => response('{"reply":"正常结果"}');
  assert.equal((await generateConversationReply(input, () => { throw Error("observer failure"); })).reply, "正常结果");
} finally { globalThis.fetch = originalFetch; }
console.log("HTTP request diagnostics: terminal once, explicit-zero/missing usage, malformed repair, thinking400 fallback, timeout and observer isolation passed (mocked).");

// 首 Token（首字节）计时：只在真的测到 firstByte 时派生 ttfb/tail，拿不到就留 undefined。
{
  const realNow = Date.now;
  let clock = 1_700_000_000_000;
  Date.now = () => clock;
  try {
    // 正常：markFirstByte 后 complete，派生 startedAt/firstByteAt/endedAt/ttfbMs/tailMs。
    const ok: AssistantRequestDiagnostic[] = [];
    const req = startAssistantRequest(entry => ok.push(entry));
    clock += 500; req.markFirstByte(); clock += 700; req.complete("success", { choices: [{ finish_reason: "stop", message: { content: "{}" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    assert.equal(ok.length, 1);
    assert.equal(ok[0]!.ttfbMs, 500, "首字节等待 = firstByte - start");
    assert.equal(ok[0]!.tailMs, 700, "剩余响应 = end - firstByte");
    assert.equal(ok[0]!.durationMs, 1200, "总耗时 = end - start");
    assert.equal(ok[0]!.startedAt, 1_700_000_000_000);
    assert.equal(ok[0]!.firstByteAt, 1_700_000_000_500);
    assert.equal(ok[0]!.endedAt, 1_700_000_001_200);

    // 未 markFirstByte（如 http_error / 空响应解析失败）：不伪造 ttfb/tail。
    const none: AssistantRequestDiagnostic[] = [];
    startAssistantRequest(entry => none.push(entry)).complete("http_error");
    assert.equal(none[0]!.ttfbMs, undefined);
    assert.equal(none[0]!.tailMs, undefined);
    assert.equal(none[0]!.firstByteAt, undefined);
    assert.equal(none[0]!.startedAt, 1_700_000_001_200);
    assert.equal(none[0]!.endedAt, 1_700_000_001_200);

    // 时钟回跳（firstByte 在结束之后）：视为不可用，不派生。
    const jumped: AssistantRequestDiagnostic[] = [];
    const reqJump = startAssistantRequest(entry => jumped.push(entry));
    clock += 100; reqJump.markFirstByte(); clock -= 500; reqJump.complete("success", { choices: [{ finish_reason: "stop", message: { content: "{}" } }] });
    assert.equal(jumped[0]!.ttfbMs, undefined, "时钟回跳不能产生负的 ttfb");

    // markFirstByte 重复调用只记第一次。
    const dup: AssistantRequestDiagnostic[] = [];
    const reqDup = startAssistantRequest(entry => dup.push(entry));
    clock += 100; reqDup.markFirstByte(); clock += 100; reqDup.markFirstByte(); clock += 100; reqDup.complete("success", { choices: [{ finish_reason: "stop", message: { content: "{}" } }] });
    assert.equal(dup[0]!.ttfbMs, 100);
    assert.equal(dup[0]!.tailMs, 200);
  } finally { Date.now = realNow; }
}
console.log("First-byte timing: derived ttfb/tail on success, unavailable when unmeasured, clock-jump safe, first-mark wins (mocked).");
