import assert from "node:assert/strict";
import { generateConversationReply } from "../server/utils/chat-reply";
import { attachImageDescriptions, buildStoredMessageMetadata, type ChannelTurnMessage } from "../server/utils/channel-adapter/pipeline";
import { observeOnebotMedia } from "../server/utils/channel-adapter/media-observation";
import { readOnebotImages, readOnebotMedia, readOnebotMessageParts, readOnebotMessageText, readOnebotCommandText } from "../server/utils/channel-adapter/onebot/types";

const originalFetch = globalThis.fetch;
let request: { messages: Array<{ role: string; content: string }> };
globalThis.fetch = async (_url, init) => {
  request = JSON.parse(String(init?.body));
  return Response.json({ choices: [{ message: { content: JSON.stringify({ reply: "接着说吧。" }) }, finish_reason: "stop" }] });
};
const settings = { model: "mock", apiBaseUrl: "https://mock.invalid/v1", apiKey: "test" };
const context = { modelConfig: {}, chatModel: settings.model, apiBaseUrl: settings.apiBaseUrl, apiKey: settings.apiKey, characterId: "fixture-character", bindingId: "fixture-binding" };
const event = { message: [
  { type: "text", data: { text: "@123456789 这个表情包什么意思？字面[图片] " } },
  { type: "image", data: { sub_type: 1, url: "https://media.invalid/sticker?rkey=secret" } },
  { type: "mface", data: { summary: "[图片]是表情名" } },
  { type: "image", data: { sub_type: 0, url: "https://media.invalid/photo" } },
] };
const parts = readOnebotMessageParts(event);
const message: ChannelTurnMessage = { externalMessageId: "fixture-message", authorOpenId: "123456789", content: readOnebotMessageText(event), commandText: readOnebotCommandText(event),
  promptContent: readOnebotMessageText(event).replace("@123456789", "@member_1"), images: readOnebotImages(event), observedMedia: observeOnebotMedia(readOnebotMedia(event)),
  imageTextParts: parts, promptImageTextParts: parts.map(part => part.type === "text" ? { ...part, text: part.text.replace("@123456789", "@member_1") } : part),
};
try {
  const [processed] = await attachImageDescriptions([message], context, { resolveSettings: async () => settings,
    describe: async refs => { assert.equal(refs[0]?.mediaKind, "sticker"); assert.equal(refs[1]?.mediaKind, "image"); return ["小动物[笑脸]\n举起双手", "一张纸上写着三点"]; },
  });
  assert(processed);
  assert(processed.content.includes("字面[图片]"));
  assert(processed.content.includes("[表情包：小动物（笑脸） 举起双手]"));
  assert(processed.content.includes("[图片：一张纸上写着三点]"));
  assert(processed.promptContent?.includes("@member_1"));
  assert(!processed.promptContent?.includes("123456789"));
  assert(!processed.content.includes("rkey"));
  const base = { characterName: "测试角色", characterPrompt: "自然聊天", model: "mock", apiKey: "test", apiBaseUrl: settings.apiBaseUrl,
    currentMessage: processed.promptContent!, recentMessages: [], memories: [], snapshots: [] };
  const reply = await generateConversationReply({ ...base, groupChat: true, transcript: [{ id: "fixture", speaker: "群友", member: "member_1", content: processed.promptContent!, isOwner: false }] });
  assert.equal(reply.promptTemplateVersion, "conversation-retrieval-v89");
  const system = request!.messages.find(m => m.role === "system")!.content;
  const payload = request!.messages.find(m => m.role === "user")!.content;
  assert(system.includes("without unsolicited narration, aesthetic judgments"));
  assert(system.includes("Only describe or explain its visible content when the person explicitly asks"));
  assert(system.includes("A bare sticker token does not reveal a specific emotion"));
  assert(system.includes("In ordinary conversation, continue naturally without announcing a media failure"));
  assert(system.includes("If the person explicitly asks about an image or sticker"));
  assert(!system.includes("Respond using that description"));
  assert(payload.includes("[表情包]"));
  assert(!payload.includes("[表情包："), "default prompt does not expose sticker scene details");
  assert(payload.includes("[图片：一张纸上写着三点]"), "ordinary image descriptions remain available");
  assert(!JSON.stringify(request!).includes("media.invalid"));
  assert(!JSON.stringify(request!).includes("123456789"));
  const [failed] = await attachImageDescriptions([message], context, { resolveSettings: async () => settings, describe: async () => [null, null] });
  assert(failed);
  assert(!failed.content.includes("无法读取"));
  assert(failed.content.includes("[表情包]"));
  const metadata = buildStoredMessageMetadata({ platform: "qq-onebot", storedReason: "replied", message: failed });
  assert(JSON.stringify(metadata.media).includes("description_unavailable"), "failure diagnostics belong to metadata");
  await generateConversationReply({ ...base, currentMessage: "这张图上写了什么？[图片]" });
  assert(request!.messages[0]!.content.includes("briefly state the specific missing information"));
  await generateConversationReply({ ...base, currentMessage: "[表情包]", recentMessages: [{ role: "USER", content: "[图片：无法读取]" }] });
  assert(request!.messages[0]!.content.includes("Legacy [图片：无法读取] also means no visual content"));
  await generateConversationReply({ ...base, currentMessage: "这是什么意思？", quotedMessage: { messageId: "fixture-quote", content: "[表情包]", isSelf: false } });
  assert(request!.messages[0]!.content.includes("A bare sticker token does not reveal a specific emotion"), "quoted-only stickers must enable media rules");
  await generateConversationReply({ ...base, currentMessage: "这是什么意思？", groupChat: true,
    transcript: [{ id: "fixture-quoted", content: "这是什么意思？", quoted: { id: "fixture-quote", content: "[图片]" } }] });
  assert(request!.messages[0]!.content.includes("[图片：…] supplies an image description"));
  console.log("Media reply behavior: real structured tokens, member privacy, failed-read fallback and prompt contracts passed (mocked; model semantics unmeasured).");
} finally { globalThis.fetch = originalFetch; }
