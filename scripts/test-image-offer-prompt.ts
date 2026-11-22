import assert from "node:assert/strict";
import { generateConversationReply, type ConversationReplyInput } from "../server/utils/chat-reply";

const originalFetch = globalThis.fetch;
let output: Record<string, unknown> = {};
let request: { messages: Array<{ role: string; content: string }> };
globalThis.fetch = async (_url, init) => {
  request = JSON.parse(String(init?.body));
  return Response.json({ choices: [{ message: { content: JSON.stringify(output) }, finish_reason: "stop" }] });
};
const base: ConversationReplyInput = { characterName: "测试角色", characterPrompt: "自然交流", model: "mock", apiKey: "test", apiBaseUrl: "https://model.invalid/v1",
  currentMessage: "你想画什么？", recentMessages: [], memories: [], snapshots: [], imageEnabled: true };
const system = () => request!.messages.find(row => row.role === "system")!.content;
const payload = () => JSON.parse(request!.messages.find(row => row.role === "user")!.content);
try {
  output = { reply: "想试试画一只鲸鱼，你看呢？", imageOffer: " 蓝色鲸鱼\n跃出海面\u0000，日落光线 ", imagePrompt: "unapproved image" };
  const offered = await generateConversationReply(base);
  assert.equal(offered.promptTemplateVersion, "conversation-retrieval-v88");
  assert.equal(offered.imageOffer, "蓝色鲸鱼 跃出海面 ，日落光线");
  assert.equal(offered.imagePrompt, null, "proposal cannot become an unapproved image prompt");
  assert(system().includes("imageOffer only for a proposal you actually make in this reply"));
  assert(system().includes("not for an old proposal") || system().includes("never for an old proposal"));
  assert(system().includes("Do not offer a picture every turn"));
  assert(system().includes("optional imageOffer"));
  for (const value of [null, {}, [], 123, true, " \n\u0000 "]) {
    output = { reply: "想画鲸鱼", imageOffer: value };
    assert.equal((await generateConversationReply(base)).imageOffer, null);
  }
  output = { reply: "想画鲸鱼", imageOffer: "鲸".repeat(1300) };
  assert.equal((await generateConversationReply(base)).imageOffer?.length, 1200);
  output = { reply: "想画鲸鱼", imageOffer: "鲸鱼", imagePrompt: "鲸鱼跃出海面" };
  const disabled = await generateConversationReply({ ...base, imageEnabled: false });
  assert.equal(disabled.imageOffer, null);
  assert(!system().includes("optional imageOffer"));
  const planned = await generateConversationReply({ ...base, imageReply: true, imageExecution: { plannedThisTurn: true, latestAssistant: "offered" } });
  assert.equal(planned.imageOffer, null, "approved generation cannot reopen its offer");
  assert.equal(planned.imagePrompt, "鲸鱼跃出海面");
  assert(!system().includes("Your reply is the line you say while handing the picture over"));
  assert(!system().includes("A picture is being generated for this reply and will be sent"));
  assert(system().includes("generation and delivery have not yet been confirmed"));
  assert(system().includes("Do not say '画好了', '已发送'"));
  assert.deepEqual(payload().imageExecution, { plannedThisTurn: true, latestAssistant: "offered" });
  output = { action: "silent", reply: "", imageOffer: "鲸鱼" };
  const silent = await generateConversationReply({ ...base, groupChat: true, allowSilent: true, transcript: [{ id: "fixture", content: "好安静" }] });
  assert.equal(silent.action, "silent");
  assert.equal(silent.imageOffer, undefined, "silent offer must be discarded");
  output = { reply: "", memoryAssistantQuery: "之前提议的画", imageOffer: "鲸鱼" };
  const lookup = await generateConversationReply({ ...base, memoryAssistantAvailable: true });
  assert.equal(lookup.imageOffer, undefined, "internal lookup is not a spoken offer");
  output = { reply: "还没有确认这次画出来。" };
  await generateConversationReply({ ...base, currentMessage: "画了吗？", imageExecution: { plannedThisTurn: false, latestAssistant: "not_requested" },
    recentMessages: [{ role: "ASSISTANT", content: "上一张苹果", occurredAt: "2026-01-01T00:00:00Z", hadImage: true },
      { role: "ASSISTANT", content: "我想画鲸鱼。", occurredAt: "2026-01-01T00:01:00Z" }] });
  assert(system().includes("an old sent picture does not prove a later drawing proposal or request was executed"));
  assert(system().includes("takes precedence over conversational claims such as '画好了'"));
  assert(system().includes("A status question alone is not a new drawing request"));
  assert.deepEqual(payload().imageExecution, { plannedThisTurn: false, latestAssistant: "not_requested" });
  await generateConversationReply({ ...base, imageExecution: { plannedThisTurn: false, latestAssistant: "sent", privateId: "not-for-model", prompt: "not-for-model" } as never });
  assert(!JSON.stringify(payload().imageExecution).includes("not-for-model"));
  await generateConversationReply({ ...base, imageExecution: { plannedThisTurn: true, latestAssistant: "invented" } as never });
  assert.equal(payload().imageExecution, undefined);
  console.log("Image offer prompt: capability/offer/execution separation, output whitelist, silence, history scope and evidence privacy passed (mock only).");
} finally { globalThis.fetch = originalFetch; }
