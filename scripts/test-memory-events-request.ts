import assert from "node:assert/strict";
import { analyzeMemoryPeriod } from "../server/utils/memory-ai";

const originalFetch = globalThis.fetch;
let content: unknown;
let request: { messages: Array<{ role: string; content: string }> };
const input = {
  mode: "events" as const, apiKey: "mock-events-secret", apiBaseUrl: "https://mock.example/v1", model: "mock-events",
  periodStart: "2026-11-05T00:00:00Z", periodEnd: "2026-11-06T00:00:00Z", timezone: "Asia/Shanghai",
  scopeType: "CHARACTER_GLOBAL", characterName: "测试角色",
  messages: [{ id: "new", role: "USER", eventType: "message", content: "我答应了。", occurredAt: "2026-11-05T10:01:00Z" }],
  contextMessages: [{ id: "old", role: "USER", eventType: "message", content: "周末一起读书好吗？", occurredAt: "2026-11-05T10:00:00Z" }],
  totalMessageCount: 1, omittedMessageCount: 0, activeMemories: [], previousSnapshotSummary: null,
};
const event = (ids: string[]) => ({ occurredAt: "2026-11-05T10:01:00Z", precision: "exact", title: "约定周末读书",
  detail: "双方约定周末读书，尚未履行。", confidence: 0.9, keywords: ["读书"], participants: [], evidenceMessageIds: ids });
globalThis.fetch = async (_url, init) => {
  request = JSON.parse(String(init?.body));
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }));
};
try {
  content = { events: [event(["old", "new"]), event(["old"]), event(["unknown"])],
    memoryChanges: [{ action: "ADD", content: "不应使用" }] };
  const result = await analyzeMemoryPeriod(input);
  assert.equal(result.analysis.events.length, 1);
  assert.deepEqual(result.analysis.events[0]!.evidenceMessageIds, ["old", "new"]);
  assert.deepEqual(result.analysis.memoryChanges, []);
  assert.equal(result.analysis.summary, "");
  assert.equal(result.promptTemplateVersion, "memory-events-v1");
  assert(result.durationMs >= 0);
  assert.equal(result.usage?.totalTokens, 120);
  const system = request!.messages.find(m => m.role === "system")!.content;
  const user = JSON.parse(request!.messages.find(m => m.role === "user")!.content);
  assert(!system.includes('"memoryChanges"'));
  assert(!system.includes('"summary"'));
  for (const rule of [/target=other/, /已经发生、明确计划\/约定/u,
    /相邻前文/u, /真实的 evidenceMessageIds/u, /existingEvents/u, /speaker/u, /不要编造人物/u]) assert.match(system, rule);
  for (const key of ["activeMemories", "previousSnapshotSummary", "globalMemories", "periodEvents"]) assert(!(key in user));
  assert(!JSON.stringify(request!).includes(input.apiKey));
  content = { events: [] };
  assert.equal((await analyzeMemoryPeriod(input)).analysis.events.length, 0);
  for (const invalid of [{}, { events: null }, { events: {} }]) {
    content = invalid;
    await assert.rejects(analyzeMemoryPeriod(input), /LLM_INVALID_RESPONSE/);
  }
  console.log("Event-only extraction passed: compact contract, evidence checks, empty events, invalid responses and duration (mock only).");
} finally { globalThis.fetch = originalFetch; }
