import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { parseExpressionHabitCreate, parseExpressionHabitPatch, expressionHabitNextStatus } from "../server/utils/expression-habits-domain";
import { parseExpressionHabitSuggestion } from "../server/utils/expression-habit-suggestion";
import { selectExpressionHabitsForPrompt, usedExpressionHabitSnapshots } from "../server/utils/expression-habit-retrieval";
import { generateConversationReply } from "../server/utils/chat-reply";
import { readStoredChatSources } from "../server/utils/chat-sources";

const source = { type: "MEMORY_EVENT", id: randomUUID(), hash: "a".repeat(64) };
const valid = { kind: "LENGTH", content: "闲聊倾向简短，解释复杂问题时可以展开。", context: "", reason: "手工确认的表达倾向" };
assert.equal(parseExpressionHabitCreate(valid).status, "PENDING");
assert.throws(() => parseExpressionHabitCreate({ ...valid, sources: [source], status: "ACTIVE" }));
assert.throws(() => parseExpressionHabitCreate({ ...valid, content: "长".repeat(301) }));
assert.throws(() => parseExpressionHabitCreate({ ...valid, context: "长".repeat(201) }));
assert.throws(() => parseExpressionHabitPatch({ operation: "ACTIVATE", expectedRevision: 1, content: "不能同时修改" }));
assert.equal(expressionHabitNextStatus("DISABLED", "ACTIVATE"), "ACTIVE");
assert.throws(() => expressionHabitNextStatus("REJECTED", "ACTIVATE"));
assert.equal(parseExpressionHabitSuggestion('{"skip":true}'), null);
assert.deepEqual(parseExpressionHabitSuggestion(JSON.stringify(valid)), valid);
assert.throws(() => parseExpressionHabitSuggestion(JSON.stringify({ ...valid, status: "ACTIVE" })));
const records = [
  { id: "general", kind: "LENGTH", content: "闲聊简短", context: "", revision: 1, status: "ACTIVE" },
  { id: "scene", kind: "TONE", content: "安慰时语气平和", context: "难过 安慰", revision: 2, status: "ACTIVE" },
  { id: "pending", kind: "WORDING", content: "不应注入", context: "", revision: 1, status: "PENDING" },
  { id: "disabled", kind: "WORDING", content: "不应注入", context: "", revision: 1, status: "DISABLED" },
];
assert.deepEqual(selectExpressionHabitsForPrompt("早上好", records).map(x => x.id), ["general"]);
const selected = selectExpressionHabitsForPrompt("有点难过", records);
assert.deepEqual(selected.map(x => x.id), ["scene", "general"]);
assert.deepEqual(selectExpressionHabitsForPrompt("难过", records, 1), []);
assert(JSON.stringify(selected).length <= 800);
assert.deepEqual(usedExpressionHabitSnapshots(selected, ["invented"]), []);
assert.deepEqual(readStoredChatSources({ usedSources: { expressionHabits: selected } }).expressionHabits, selected);
const originalFetch = globalThis.fetch;
let captured = ""; let silent = false;
globalThis.fetch = async (_input, init) => {
  captured = String(init?.body);
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ action: silent ? "silent" : "reply", reply: silent ? "" : "我听着呢。", usedExpressionHabitIds: ["scene", "scene", "invented"] }) } }] }), { status: 200 });
};
try {
  const input = { characterName: "角色", characterPrompt: "自然交流", model: "mock", apiKey: "test", apiBaseUrl: "https://mock.example/v1", currentMessage: "难过", recentMessages: [], memories: [], snapshots: [], expressionHabits: selected };
  const reply = await generateConversationReply(input);
  assert.deepEqual(reply.usedExpressionHabitIds, ["scene"]);
  assert.match(captured, /expressionHabits are confirmed tendencies/);
  assert.match(captured, /do not override identity, privacy, facts/);
  assert.equal(reply.promptTemplateVersion, "conversation-retrieval-v58");
  silent = true;
  assert.deepEqual((await generateConversationReply({ ...input, groupChat: true, allowSilent: true, transcript: [{ id: "msg", speaker: "群友", content: "难过" }] })).usedExpressionHabitIds, []);
} finally { globalThis.fetch = originalFetch; }
console.log("Expression habits: parser, lifecycle, scene selection, budget, prompt precedence, citations and silence passed.");
