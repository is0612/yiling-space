import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { parsePreferenceCreate, parsePreferencePatch, parsePreferenceListQuery, preferenceNextStatus } from "../server/utils/preferences-domain";
import { selectPreferencesForPrompt, usedPreferenceSnapshots } from "../server/utils/preference-retrieval";
import { parsePreferenceSuggestion } from "../server/utils/preference-suggestion";
import { generateConversationReply } from "../server/utils/chat-reply";
import { readStoredChatSources } from "../server/utils/chat-sources";

const source = { type: "MEMORY_EVENT", id: randomUUID(), hash: "a".repeat(64) };
assert.throws(() => parsePreferenceCreate({ kind: "LIKE", topic: "星空", reason: "观察", sources: [source], status: "ACTIVE" }));
assert.throws(() => parsePreferenceCreate({ kind: "LIKE", topic: "星空", reason: "观察", ownerId: randomUUID() }));
assert.throws(() => parsePreferenceCreate({ kind: "LIKE", topic: "星空", reason: "观察", sources: [source, source] }));
assert.throws(() => parsePreferencePatch({ expectedRevision: 1, operation: "ACTIVATE", topic: "绕过" }));
assert.throws(() => parsePreferencePatch({ expectedRevision: 0, operation: "EDIT", reason: "修改" }));
assert.equal(preferenceNextStatus("PENDING", "ACTIVATE"), "ACTIVE");
assert.throws(() => preferenceNextStatus("REJECTED", "ACTIVATE"));
assert.throws(() => parsePreferenceListQuery({ pageSize: "500" }));
assert.equal(parsePreferenceSuggestion('{"skip":true}'), null);
assert.deepEqual(parsePreferenceSuggestion('```json\n{"kind":"INTEREST","topic":"星空","reason":"观察到持续主动讨论；可能感兴趣。"}\n```'), { kind: "INTEREST", topic: "星空", reason: "观察到持续主动讨论；可能感兴趣。" });
assert.throws(() => parsePreferenceSuggestion('{"kind":"LIKE","topic":"星空","reason":"观察","status":"ACTIVE"}'));
const rows = [
  { id: "like", kind: "LIKE", topic: "星空", reason: "持续关注天文", revision: 1, status: "ACTIVE" },
  { id: "opposing", kind: "DISLIKE", topic: "星空", reason: "另一个有分歧的观察", revision: 2, status: "ACTIVE" },
  { id: "private", kind: "LIKE", topic: "星空", reason: "待确认", revision: 1, status: "PENDING" },
  { id: "disabled", kind: "LIKE", topic: "星空", reason: "已关闭", revision: 1, status: "DISABLED" },
];
const selected = selectPreferencesForPrompt("聊聊星空", rows);
assert.deepEqual(new Set(selected.map(row => row.id)), new Set(["like", "opposing"]));
assert.deepEqual(selectPreferencesForPrompt("早上好", rows), []);
assert.deepEqual(selectPreferencesForPrompt("星空", rows, 1), []);
assert.deepEqual(usedPreferenceSnapshots(selected, ["invented"]), []);
assert.deepEqual(readStoredChatSources({ usedSources: { preferences: selected } }).preferences, selected);
assert.deepEqual(readStoredChatSources({ usedSources: { preferences: [{ ...selected[0], revision: -1 }] } }), { memories: [], snapshots: [] });
const originalFetch = globalThis.fetch;
let silent = false;
let captured = "";
globalThis.fetch = async (_input, init) => {
  captured = String(init?.body);
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ action: silent ? "silent" : "reply", reply: silent ? "" : "今晚想看看星空。", usedPreferenceIds: ["like", "invented", "like"] }) } }] }), { status: 200 });
};
try {
  const input = { characterName: "角色", characterPrompt: "自然交流", model: "mock", apiKey: "test-key", apiBaseUrl: "https://mock.example/v1", currentMessage: "聊聊星空", recentMessages: [], memories: [], snapshots: [], preferences: selected };
  const result = await generateConversationReply(input);
  assert.deepEqual(result.usedPreferenceIds, ["like"]);
  assert.match(captured, /this character's own confirmed likes/);
  assert.match(captured, /conversation-retrieval-v54|YILING_CONVERSATION_REPLY_V54/);
  silent = true;
  const resultSilent = await generateConversationReply({ ...input, groupChat: true, allowSilent: true, transcript: [{ id: "msg", speaker: "群友", content: "星空" }] });
  assert.deepEqual(resultSilent.usedPreferenceIds, []);
} finally { globalThis.fetch = originalFetch; }
console.log("Preference parser, state, budget, opposing evidence, model whitelist and silence checks passed.");
