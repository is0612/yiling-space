import assert from "node:assert/strict";
import { generateConversationReply } from "../server/utils/chat-reply";
const original = globalThis.fetch;
let captured = "";
globalThis.fetch = async (_url, init) => { captured = String(init?.body); return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ reply: "我听着。" }) } }] })); };
const base = { characterName: "测试", characterPrompt: "自然交流", model: "mock", apiKey: "fake", apiBaseUrl: "https://mock.example/v1", currentMessage: "我很难过", recentMessages: [], memories: [], snapshots: [] };
const guidance = { id: "guidance", content: "倾诉时先倾听，再确认是否需要建议", context: "倾诉难过", weight: 1, sourceRefs: [{ content: "PRIVATE_SOURCE_MARKER" }], reason: "PRIVATE_REASON_MARKER" };
try {
 for (const groupChat of [false, true]) {
  await generateConversationReply({ ...base, groupChat, interactionGuidance: [guidance], interactionExperiences: [{ id: "private", content: "PRIVATE_EXPERIENCE_MARKER", context: "私聊", weight: 1 }] });
  const payload = JSON.parse(JSON.parse(captured).messages.find((x: {role:string}) => x.role === "user").content);
  assert.deepEqual(payload.interactionGuidance.items, [{ id: guidance.id, content: guidance.content, context: guidance.context }]);
  assert.match(payload.interactionGuidance.interpretation, /Current context and explicit corrections take precedence/);
  assert(!captured.includes("PRIVATE_SOURCE_MARKER")); assert(!captured.includes("PRIVATE_REASON_MARKER"));
  assert.equal(captured.includes("PRIVATE_EXPERIENCE_MARKER"), !groupChat);
 }
 await generateConversationReply(base);
 assert(!captured.includes('"interactionGuidance"'));
} finally { globalThis.fetch = original; }
console.log("Interaction guidance prompt: reviewed abstraction in both scenes, private source exclusion and precedence passed (mock).");
