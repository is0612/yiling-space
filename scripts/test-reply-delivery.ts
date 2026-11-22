import assert from "node:assert/strict";
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
  assert.equal(reply.promptTemplateVersion, "conversation-retrieval-v85");
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
console.log("reply delivery identity remapping and mocked prompt tests passed");
