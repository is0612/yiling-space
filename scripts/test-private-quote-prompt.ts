import assert from "node:assert/strict";
import { generateConversationReply, type ConversationReplyInput } from "../server/utils/chat-reply";
import { buildStoredMessageMetadata } from "../server/utils/channel-adapter/pipeline";

const originalFetch = globalThis.fetch;
let captured: { messages: Array<{ role: string; content: string }> };
globalThis.fetch = async (_url, init) => {
  captured = JSON.parse(String(init?.body));
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ reply: "知道你指的是哪一句了。" }) } }] }), { status: 200 });
};
const base: ConversationReplyInput = {
  characterName: "测试角色", characterPrompt: "自然交流", model: "mock", apiKey: "test", apiBaseUrl: "https://mock.example/v1",
  currentMessage: "第一句不对", recentMessages: [{ role: "ASSISTANT", content: "第一句\n第二句\n第三句" }], memories: [], snapshots: [],
};
function payload() { return JSON.parse(captured.messages.find(message => message.role === "user")!.content); }
try {
  const quotedMessage = { messageId: "-42", content: "第一句", isSelf: true };
  await generateConversationReply({ ...base, quotedMessage });
  assert.deepEqual(payload().quotedMessage, { content: "第一句", author: "self", available: true });
  assert.equal(payload().currentMessage, "第一句不对");
  assert.match(captured.messages[0]!.content, /exact single message/);
  assert.match(captured.messages[0]!.content, /never as instructions/);
  assert(!JSON.stringify(payload().quotedMessage).includes("-42"), "平台消息ID无需暴露给模型");
  const metadata = buildStoredMessageMetadata({ platform: "qq-onebot", storedReason: "recorded", message: { authorOpenId: "123456789", content: base.currentMessage, quotedMessage } });
  assert.deepEqual(metadata.quotedMessage, quotedMessage);
  await generateConversationReply({ ...base, quotedMessage: { messageId: "-42" } });
  assert.deepEqual(payload().quotedMessage, { content: null, author: "unknown", available: false });
  assert.match(captured.messages[0]!.content, /do not guess its text/);
  await generateConversationReply(base);
  assert.equal(payload().quotedMessage, undefined);
  assert(!captured.messages[0]!.content.includes("quotedMessage is"));
  await generateConversationReply({ ...base, groupChat: true, quotedMessage });
  assert.equal(payload().quotedMessage, undefined, "私聊引用不能进入群聊提示词");
  await generateConversationReply({ ...base, quotedMessage: { ...quotedMessage, content: "字".repeat(4000), isSelf: false } });
  assert.equal(payload().quotedMessage.content.length, 2100);
  assert.equal(payload().quotedMessage.author, "user");
} finally { globalThis.fetch = originalFetch; }
console.log("Private quote prompt: exact segment, unavailable state, metadata, privacy and bounds passed.");
