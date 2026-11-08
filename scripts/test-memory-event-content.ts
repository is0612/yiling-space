import assert from "node:assert/strict";
import { analyzeMemoryPeriod } from "../server/utils/memory-ai";

const originalFetch = globalThis.fetch;
const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
const at = "2026-11-05T10:00:00.000Z";
const event = (title: string, evidenceMessageIds: string[], precision = "day") => ({
  title, detail: title, occurredAt: at, precision, evidenceMessageIds, participants: [], keywords: [], confidence: 0.9,
});
globalThis.fetch = async (_input, init) => {
  requests.push(JSON.parse(String(init?.body)));
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
    summary: "测试", events: [event("新消息和前文共同支持", ["old", "new"]), event("只引用前文不能重记", ["old"]), event("不存在的来源", ["missing"])],
  }) } }] }), { headers: { "content-type": "application/json" } });
};
try {
  const result = await analyzeMemoryPeriod({
    apiKey: "mock-test-key", apiBaseUrl: "http://127.0.0.1:4010/v1", model: "mock-events",
    periodStart: "2026-11-05T00:00:00Z", periodEnd: "2026-11-06T00:00:00Z", timezone: "America/Los_Angeles",
    scopeType: "CHARACTER_GLOBAL", characterName: "测试角色",
    messages: [{ id: "new", role: "USER", eventType: "message", content: "刚和他从那里回来。", occurredAt: at }],
    contextMessages: [{ id: "old", role: "USER", eventType: "message", content: "今天和小林约去海洋馆。", occurredAt: at }],
    totalMessageCount: 1, omittedMessageCount: 0, activeMemories: [], previousSnapshotSummary: null,
  });
  assert.equal(result.analysis.events.length, 1, "Context can support new events but cannot produce old-only or unknown-source events.");
  assert.deepEqual(result.analysis.events[0]!.evidenceMessageIds, ["old", "new"]);
  assert.equal(result.analysis.events[0]!.precision, "day", "Explicit day precision must survive non-UTC-midnight timestamps.");
  assert.equal(result.promptTemplateVersion, "memory-extraction-v8");
  const prompt = requests[0]!.messages.find((message) => message.role === "system")!.content;
  assert.match(prompt, /已经发生、明确计划\/约定/u);
  assert.match(prompt, /助手提议和角色扮演/u);
  assert.match(prompt, /本地日期取当天零点再换算成 UTC/u);
  const user = JSON.parse(requests[0]!.messages.find((message) => message.role === "user")!.content);
  assert.equal(user.contextMessages[0].content, "今天和小林约去海洋馆。");
  assert.equal(user.contextMessages[0].id, "old");
  assert(!JSON.stringify(user).includes("mock-test-key"));
  console.log("Event content request checks passed: evidence context, new-message requirement, explicit day precision and fact/plan instructions (no provider calls).");
} finally {
  globalThis.fetch = originalFetch;
}
