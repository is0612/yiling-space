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

// 分段计时（响应头等待 + Body 读取）：只在真的测到阶段标记时派生，拿不到就留 undefined。
{
  const realNow = Date.now;
  let clock = 1_700_000_000_000;
  Date.now = () => clock;
  try {
    // 正常：markHeaders 后 markBody 再 complete，派生 startedAt/headersAt/bodyAt/endedAt/headersMs/bodyMs。
    const ok: AssistantRequestDiagnostic[] = [];
    const req = startAssistantRequest(entry => ok.push(entry));
    clock += 500; req.markHeaders(); clock += 700; req.markBody(); clock += 300; req.complete("success", { choices: [{ finish_reason: "stop", message: { content: "{}" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    assert.equal(ok.length, 1);
    assert.equal(ok[0]!.headersMs, 500, "响应头等待 = headersAt - start");
    assert.equal(ok[0]!.bodyMs, 700, "Body 读取解析 = bodyAt - headersAt");
    assert.equal(ok[0]!.durationMs, 1500, "总耗时 = end - start");
    assert.equal(ok[0]!.startedAt, 1_700_000_000_000);
    assert.equal(ok[0]!.headersAt, 1_700_000_000_500);
    assert.equal(ok[0]!.bodyAt, 1_700_000_001_200);
    assert.equal(ok[0]!.endedAt, 1_700_000_001_500);

    // 只有 markHeaders（如 http_error 前 fetch 已 resolve）：记 headers 但不伪造 body。
    const headersOnly: AssistantRequestDiagnostic[] = [];
    const reqH = startAssistantRequest(entry => headersOnly.push(entry));
    clock += 400; reqH.markHeaders(); clock += 50; reqH.complete("http_error");
    assert.equal(headersOnly[0]!.headersMs, 400);
    assert.equal(headersOnly[0]!.bodyAt, undefined);
    assert.equal(headersOnly[0]!.bodyMs, undefined);
    assert.equal(headersOnly[0]!.durationMs, 450);

    // 完全未标记（如 fetch 抛超时）：headers/body 都不伪造。
    const none: AssistantRequestDiagnostic[] = [];
    startAssistantRequest(entry => none.push(entry)).complete("timeout");
    assert.equal(none[0]!.headersAt, undefined);
    assert.equal(none[0]!.headersMs, undefined);
    assert.equal(none[0]!.bodyAt, undefined);
    assert.equal(none[0]!.bodyMs, undefined);

    // 时钟回跳（headers/body 晚于 endedAt）：整体视为不可用，不派生。
    const jumped: AssistantRequestDiagnostic[] = [];
    const reqJump = startAssistantRequest(entry => jumped.push(entry));
    clock += 100; reqJump.markHeaders(); clock -= 500; reqJump.markBody(); clock += 200; reqJump.complete("success", { choices: [{ finish_reason: "stop", message: { content: "{}" } }] });
    assert.equal(jumped[0]!.headersMs, undefined, "headersAt 晚于 endedAt 视为不可用");
    assert.equal(jumped[0]!.bodyMs, undefined, "bodyAt 乱序不能产生负的 bodyMs");

    // bodyAt 早于 headersAt（仍在 endedAt 内）：headers 有效，body 乱序不可用。
    const bodyEarly: AssistantRequestDiagnostic[] = [];
    const reqEarly = startAssistantRequest(entry => bodyEarly.push(entry));
    clock += 300; reqEarly.markHeaders(); clock -= 100; reqEarly.markBody(); clock += 200; reqEarly.complete("success", { choices: [{ finish_reason: "stop", message: { content: "{}" } }] });
    assert.equal(bodyEarly[0]!.headersMs, 300, "headers 在时间轴内仍有效");
    assert.equal(bodyEarly[0]!.bodyMs, undefined, "bodyAt 早于 headersAt 视为不可用");

    // markHeaders / markBody 重复调用只记第一次。
    const dup: AssistantRequestDiagnostic[] = [];
    const reqDup = startAssistantRequest(entry => dup.push(entry));
    clock += 100; reqDup.markHeaders(); clock += 100; reqDup.markHeaders(); clock += 100; reqDup.markBody(); clock += 100; reqDup.markBody(); clock += 100; reqDup.complete("success", { choices: [{ finish_reason: "stop", message: { content: "{}" } }] });
    assert.equal(dup[0]!.headersMs, 100);
    assert.equal(dup[0]!.bodyMs, 200, "bodyMs = bodyAt(第3次推进) - headersAt(第1次推进)");
  } finally { Date.now = realNow; }
}
console.log("Segmented timing: headers/body derived on success, unavailable when unmeasured, clock-jump safe, first-mark wins (mocked).");
