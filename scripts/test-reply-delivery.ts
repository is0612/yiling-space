import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { readDeliveredAtMention, readDeliveredAtTarget, blockedDeliveredAtTargets } from "../server/utils/channel-adapter/reply-delivery";
import { GroupContext } from "../server/utils/channel-adapter/onebot/group-context";
import { generateConversationReply } from "../server/utils/chat-reply";

const qq = "123456789"; // Synthetic fixture only.
const stored = { replyDelivery: { at: { requestedMessageId: "old-id", targetQq: qq, status: "sent", sentAt: "2026-01-01T00:00:00Z" } } };
const first = new GroupContext();
first.memberCode("group", qq);
const restarted = new GroupContext();
restarted.memberCode("group", "987654321");
const resolve = (uid: string) => ({ member: restarted.memberCode("group", uid) });
const mentions = readDeliveredAtMention(stored, resolve);
assert.deepEqual(mentions, [{ target: "other", member: "member_2" }]);
for (const metadata of [null, {}, { replyDelivery: [] }, { replyDelivery: { at: { targetQq: qq, status: "suppressed" } } },
  { replyDelivery: { at: { targetQq: qq, status: "requested" } } }, { replyDelivery: { at: { status: "sent" } } },
  { replyDelivery: { at: { targetQq: "all", status: "sent" } } }]) {
  assert.deepEqual(readDeliveredAtMention(metadata, resolve), []);
}
assert.deepEqual(readDeliveredAtMention(stored), []);
assert.equal(readDeliveredAtTarget(stored), qq);
// The target can exist only in an old assistant receipt, outside the live member window.
const oldTargets = [readDeliveredAtTarget(stored)!];
const blockedOldTargets = blockedDeliveredAtTargets(oldTargets, [{ platformUid: qq, kind: "HUMAN", memoryScopes: [{ friendChatPolicy: "BLOCK" }] }]);
assert(blockedOldTargets.has(qq));
assert(blockedDeliveredAtTargets(oldTargets, null).has(qq), "failed policy query must fail closed");
assert(!blockedDeliveredAtTargets(oldTargets, []).has(qq), "missing identity follows UNKNOWN/DEFAULT");
assert.deepEqual(readDeliveredAtMention(stored, uid => blockedOldTargets.has(uid) ? null : resolve(uid)), []);
assert.deepEqual(readDeliveredAtMention(stored, () => null), [], "currently blocked old target must be omitted");
assert.deepEqual(readDeliveredAtMention({ replyDelivery: { at: { targetQq: qq, status: "unknown" } } }, resolve), []);
assert.deepEqual(readDeliveredAtMention(stored, () => ({ member: qq })), []);
assert.deepEqual(readDeliveredAtMention(stored, () => ({ member: "self" })), []);

const originalFetch = globalThis.fetch;
let request: { messages: Array<{ role: string; content: string }> } | undefined;
globalThis.fetch = async (_url, init) => {
  request = JSON.parse(String(init?.body));
  return Response.json({ choices: [{ message: { content: JSON.stringify({ action: "reply", reply: "接着聊吧。" }) }, finish_reason: "stop" }] });
};
try {
  const reply = await generateConversationReply({ characterName: "测试角色", characterPrompt: "自然交流", model: "mock", apiKey: "test",
    apiBaseUrl: "https://model.invalid/v1", currentMessage: "继续", groupChat: true,
    transcript: [{ id: "current", member: "member_2", speaker: "群友", content: "继续", isOwner: false }],
    recentMessages: [{ id: "previous", role: "ASSISTANT", content: "上句话", occurredAt: "2026-01-01T00:00:00Z", mentions }],
    memories: [], snapshots: [] });
  assert.equal(reply.promptTemplateVersion, "conversation-retrieval-v92");
  const system = request!.messages.find(line => line.role === "system")!.content;
  const payload = request!.messages.find(line => line.role === "user")!.content;
  assert(system.includes("mentions records notifications actually sent"));
  assert(system.includes("answering them directly, agreeing, drawing a boundary, or continuing the current exchange does not by itself justify"));
  assert(!JSON.stringify(request).includes(qq), "Stored QQ must not enter the model request");
  const assembled = JSON.parse(payload);
  assert.deepEqual(assembled.recentMessages[0].mentions, [{ target: "other", member: "member_2" }]);
  await generateConversationReply({ characterName: "测试角色", characterPrompt: "自然交流", model: "mock", apiKey: "test",
    apiBaseUrl: "https://model.invalid/v1", currentMessage: "继续", groupChat: true,
    transcript: [{ id: "current", member: "member_1", speaker: "群友", content: "继续", isOwner: false }],
    recentMessages: [{ id: "old", role: "ASSISTANT", content: "旧话", mentions: readDeliveredAtMention(stored, () => null) }], memories: [], snapshots: [] });
  assert(!JSON.stringify(request).includes(qq));
  const blockedPayload = JSON.parse(request!.messages.find(line => line.role === "user")!.content);
  assert.equal(blockedPayload.recentMessages[0].mentions, undefined, "blocked old target cannot appear in model history");
} finally { globalThis.fetch = originalFetch; }
// Mock transport only: no QQ gateway, model, or database connections.
const { createReplySender } = await import("../server/utils/channel-adapter/onebot/serve");
const { hasEmojiMark, isEmojiBudgetSpent } = await import("../server/utils/emoji-frequency");
const config = { httpUrl: "https://onebot.invalid", wsUrl: "wss://onebot.invalid" };
const sender = createReplySender(config, { messageType: "private", userId: qq, groupId: "" });
let mediaMode: "sent" | "failed" | "unknown" = "sent";
let customRejected = false;
let customResponse: "ok" | "non_json" | "empty" | "object" | "failed_without_code" = "ok";
const outbound: unknown[] = [];
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(String(init?.body));
  outbound.push(body);
  const media = String(url).includes("send_custom_face") || Array.isArray(body.message);
  if (media && mediaMode === "unknown") throw new Error("mock connection lost");
  if (String(url).includes("send_custom_face")) {
    if (customResponse === "non_json") return new Response("not JSON");
    if (customResponse === "empty") return new Response("");
    if (customResponse === "object") return Response.json({});
    if (customResponse === "failed_without_code") return Response.json({ status: "failed" });
  }
  if (media && (mediaMode === "failed" || (customRejected && String(url).includes("send_custom_face")))) {
    return Response.json({ status: "failed", retcode: 100, wording: "mock rejected" });
  }
  return Response.json({ status: "ok", retcode: 0, data: { message_id: "mock-id" } });
};
try {
  for (const mode of ["sent", "failed", "unknown"] as const) {
    mediaMode = mode;
    for (const options of [{ faces: ["14"] }, { sticker: { id: "sticker", filePath: fileURLToPath(import.meta.url) } }]) {
      const before = outbound.length;
      const delivery = await sender("正文照常", options);
      assert.equal(delivery?.emoji?.status, mode);
      assert.equal(outbound.length - before, 2, "text remains a separate successful delivery");
      const metadata = { ...("sticker" in options ? { stickerId: "sticker" } : { faceIds: ["14"] }), replyDelivery: delivery };
      assert.equal(hasEmojiMark(metadata), mode === "sent");
      assert.equal(isEmojiBudgetSpent([{ occurredAt: new Date(), metadata }], new Date(), { windowMinutes: 10, perWindow: 1 }), mode === "sent");
    }
  }
  mediaMode = "sent";
  const missing = await sender("正文", { sticker: { id: "missing", filePath: "missing-mock-sticker.png" } });
  assert.deepEqual(missing?.emoji, { status: "failed", reason: "read_failed" });
  const custom = { id: "custom", filePath: fileURLToPath(import.meta.url), qqEmojiId: "123456789_0_0_0_abcdef_0_0" };
  assert.equal((await sender("正文", { sticker: custom }))?.emoji?.status, "sent");
  const beforeCallbackFailure = outbound.length;
  await assert.rejects(sender("正文", { sticker: custom, onDelivery: async delivery => {
    if (delivery.emoji?.status === "sent") throw new Error("mock receipt persistence failed");
  } }), /mock receipt persistence failed/);
  assert.equal(outbound.length - beforeCallbackFailure, 2, "receipt callback failure must not send an image fallback after custom face success");
  mediaMode = "unknown";
  const beforeUnknown = outbound.length;
  assert.equal((await sender("正文", { sticker: custom }))?.emoji?.status, "unknown");
  assert.equal(outbound.length - beforeUnknown, 2, "unknown custom face outcome must not fall back");
  mediaMode = "sent";
  for (const response of ["non_json", "empty", "object", "failed_without_code"] as const) {
    customResponse = response;
    const beforeInvalid = outbound.length;
    const delivery = await sender("正文", { sticker: custom });
    assert.deepEqual(delivery?.emoji, { status: "unknown", reason: "unconfirmed" }, response);
    assert.equal(outbound.length - beforeInvalid, 2, "invalid success response must not fall back");
    assert.equal(hasEmojiMark({ stickerId: custom.id, replyDelivery: delivery }), false);
  }
  customResponse = "ok";
  customRejected = true;
  const beforeFallback = outbound.length;
  assert.equal((await sender("正文", { sticker: custom }))?.emoji?.status, "sent", "rejected custom face falls back to image");
  assert.equal(outbound.length - beforeFallback, 3, "explicit rejection sends exactly one image fallback");
  assert.equal(hasEmojiMark({ stickerId: "legacy" }), true);
  assert.equal(hasEmojiMark({ faceIds: ["14"], replyDelivery: { emoji: { status: "unknown" } } }), false);
} finally { globalThis.fetch = originalFetch; }
console.log("reply delivery identity, mocked emoji receipts and budget tests passed");
