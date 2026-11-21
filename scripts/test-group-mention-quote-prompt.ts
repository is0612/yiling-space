/**
 * 群聊里「谁 @ 了谁」「谁引用了谁」必须进最终提示词。
 * 纯 mock：不连库、不调真模型。
 */
import assert from "node:assert/strict";
import { generateConversationReply } from "../server/utils/chat-reply";

const originalFetch = globalThis.fetch;
let body: { messages: Array<{ role: string; content: string }> } | null = null;
globalThis.fetch = async (_url, init) => {
  body = JSON.parse(String(init?.body)) as typeof body;
  return Response.json({
    choices: [{ message: { content: JSON.stringify({ action: "silent", reply: "" }) }, finish_reason: "stop" }],
  });
};

try {
  await generateConversationReply({
    characterName: "小鱼",
    characterPrompt: "自然交流",
    model: "mock",
    apiKey: "test-only",
    apiBaseUrl: "https://model.invalid/v1",
    groupChat: true,
    allowSilent: true,
    direct: false,
    currentMessage: "那我呢",
    transcript: [
      {
        id: "m1", member: "member_2", speaker: "甲", content: "@member_3 你昨天说的那个", isOwner: false,
        mentions: [{ target: "other", member: "member_3", speaker: "乙", kind: "HUMAN" }],
      },
      {
        id: "m2", member: "member_3", speaker: "乙", content: "我没说过", isOwner: false,
        quoted: { id: "m1", member: "member_2", speaker: "甲", content: "@member_3 你昨天说的那个" },
      },
      {
        id: "m3", member: "member_4", speaker: "丙", content: "这话我接不上", isOwner: false,
        quoted: { id: "gone", isSelf: false },
      },
    ],
    recentMessages: [],
    memories: [],
    snapshots: [],
  });

  assert(body, "the model request must be captured");
  const payload = JSON.parse(body!.messages.find((m) => m.role === "user")!.content) as Record<string, unknown>;
  const transcript = payload.transcript as Array<Record<string, unknown>>;

  const first = transcript.find((line) => line.id === "m1")!;
  assert.deepEqual(first.mentions, [{ target: "other", member: "member_3", speaker: "乙", kind: "HUMAN" }],
    "who was @'d must reach the prompt with a name, not just a member code");

  const reply = transcript.find((line) => line.id === "m2")!;
  assert.deepEqual(reply.quoted, {
    id: "m1", member: "member_2", speaker: "甲", content: "@member_3 你昨天说的那个", available: true,
  }, "a quote must carry the quoted author and text");

  const missing = transcript.find((line) => line.id === "m3")!;
  assert.deepEqual(missing.quoted, { id: "gone", content: null, available: false },
    "an unresolvable quote must say unavailable instead of inventing text");

  const prompt = body!.messages.map((m) => m.content).join("\n");
  assert(prompt.includes("quoted.available false"), "the prompt must forbid guessing a missing quote");
  assert(prompt.includes("does not prove the remark is addressed to you"), "a quote must not become proof of being addressed");

  // 群聊里的引用不能混成一整轮的单条引语（那是私聊语义）。
  assert.equal(payload.quotedMessage, undefined, "private single-quote field must stay out of group payloads");
  console.log("Group mention and quote prompt rendering passed (mock model, no database).");
} finally {
  globalThis.fetch = originalFetch;
}
