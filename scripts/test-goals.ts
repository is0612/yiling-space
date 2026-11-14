import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { parseGoalCreate, parseGoalPatch, parseGoalProgress, goalNextStatus, goalProgressPayloadHash } from "../server/utils/goals-domain";
import { parseGoalSuggestion } from "../server/utils/goal-suggestion";
import { selectGoalsForPrompt, usedGoalSnapshots } from "../server/utils/goal-retrieval";
import { generateConversationReply } from "../server/utils/chat-reply";
import { readStoredChatSources } from "../server/utils/chat-sources";
const base = { kind: "GOAL", title: "学习星座", description: "辨认几个常见星座", reason: "角色明确表示想了解" };
const source = { type: "MEMORY_EVENT", id: randomUUID(), hash: "a".repeat(64) };
assert.equal(parseGoalCreate(base).status, "PENDING");
assert.throws(() => parseGoalCreate({ ...base, status: "ACTIVE", sources: [source] }));
assert.throws(() => parseGoalPatch({ expectedRevision: 1, operation: "COMPLETE", title: "不能混合编辑" }));
assert.throws(() => parseGoalCreate({ ...base, title: "长".repeat(101) }));
for (const terminal of ["COMPLETED", "ABANDONED", "REJECTED"]) for (const op of ["EDIT", "ACTIVATE", "PAUSE", "COMPLETE", "ABANDON", "REJECT"]) assert.throws(() => goalNextStatus(terminal, op));
assert.equal(goalNextStatus("PAUSED", "ACTIVATE"), "ACTIVE");
assert.equal(goalNextStatus("ACTIVE", "COMPLETE"), "COMPLETED");
assert.equal(parseGoalProgress({ expectedRevision: 1, requestKey: randomUUID(), content: "了解了北斗星", sources: [] }).sources.length, 0);
assert.equal(goalProgressPayloadHash({ content: "记录", sources: [source] }), goalProgressPayloadHash({ content: "记录", sources: [source] }));
assert.equal(parseGoalSuggestion('{"skip":true}'), null);
assert.deepEqual(parseGoalSuggestion(JSON.stringify(base)), base);
assert.throws(() => parseGoalSuggestion(JSON.stringify({ ...base, status: "COMPLETED" })));
const rows = [
  { id: "goal", ...base, status: "ACTIVE", revision: 2, progress: [{ content: "认出了北斗星", createdAt: "2026-11-10T00:00:00Z" }] },
  { id: "paused", ...base, status: "PAUSED", revision: 1 },
  { id: "pending", ...base, status: "PENDING", revision: 1 },
  { id: "done", ...base, status: "COMPLETED", revision: 1 },
];
const selected = selectGoalsForPrompt("聊聊星座", rows);
assert.deepEqual(selected.map(row => row.id), ["goal"]);
assert.equal(selected[0]?.latestProgress?.content, "认出了北斗星");
assert.deepEqual(selectGoalsForPrompt("你好", rows), []);
assert.deepEqual(selectGoalsForPrompt("星座", rows, 1), []);
assert(JSON.stringify(selected).length <= 1000);
assert.deepEqual(usedGoalSnapshots(selected, ["invented"]), []);
assert.deepEqual(readStoredChatSources({ usedSources: { goals: selected } }).goals, selected);
const originalFetch = globalThis.fetch; let captured = ""; let silent = false;
globalThis.fetch = async (_input, init) => { captured = String(init?.body); return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ action: silent ? "silent" : "reply", reply: silent ? "" : "还想再认几个星座。", usedGoalIds: ["goal", "invented", "goal"] }) } }] }), { status: 200 }); };
try {
  const input = { characterName: "角色", characterPrompt: "自然交流", model: "mock", apiKey: "test", apiBaseUrl: "https://mock.example/v1", currentMessage: "星座", recentMessages: [], memories: [], snapshots: [], goals: selected };
  const reply = await generateConversationReply(input);
  assert.deepEqual(reply.usedGoalIds, ["goal"]); assert.equal(reply.promptTemplateVersion, "conversation-retrieval-v67");
  assert.match(captured, /Intention is not execution/); assert.match(captured, /never claim you completed a goal/);
  silent = true;
  assert.deepEqual((await generateConversationReply({ ...input, groupChat: true, allowSilent: true, transcript: [{ id: "msg", speaker: "群友", content: "星座" }] })).usedGoalIds, []);
} finally { globalThis.fetch = originalFetch; }
console.log("Goals parser, terminal states, progress input, recall budgets, source readback, prompt limits and citations passed.");
