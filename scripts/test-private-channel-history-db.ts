import "dotenv/config";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { getPrisma } from "../server/utils/prisma";
import { handleChannelMessage } from "../server/utils/channel-adapter/pipeline";

assert.match(new URL(process.env.DATABASE_URL ?? "").pathname, /^\/yiling_collaboration_test_[a-f0-9]{32}$/,
  "Use the disposable collaboration database wrapper only.");
const db = getPrisma();
const requests: Array<{ currentMessage: string; recentMessages: Array<{role:string;content:string}>; selfUnderstanding?: unknown }> = [];
const model = createServer(async (request, response) => {
  let body = ""; for await (const part of request) body += part;
  const payload = JSON.parse(body);
  requests.push(JSON.parse(payload.messages.find((row: {role:string}) => row.role === "user").content));
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({
    reply: requests.length === 1 ? "OWN_PRIOR_REPLY_SENTINEL" : "合成回复", usedMemoryIds: [], usedSnapshotIds: [],
  }) } }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }));
});
try {
  model.listen(0, "127.0.0.1"); await once(model, "listening");
  const owner = await db.user.create({ data: { username: `history-${randomUUID()}`, passwordHash: "fixture" } });
  const character = await db.character.create({ data: { ownerId: owner.id, name: "合成私聊上下文角色", basePrompt: "测试",
    modelConfig: { chatModel: "history-fixture", chatApiKey: "fixture-key", chatApiBaseUrl: `http://127.0.0.1:${(model.address() as {port:number}).port}/v1`, contextAssistantEnabled: false, memoryAssistantEnabled: false },
    memoryScopes: { create: { scopeType: "CHARACTER_GLOBAL", scopeKey: randomUUID() } },
  } });
  const connection = await db.platformConnection.create({ data: { platform: "qq-onebot", platformAccountKey: randomUUID(), displayName: "合成连接", status: "DISABLED" } });
  const binding = await db.characterChannelBinding.create({ data: { characterId: character.id, connectionId: connection.id, status: "ACTIVE" } });
  const send = async (uid: string, content: string, externalMessageId: string) => {
    const result = await handleChannelMessage({ platform: "qq-onebot", characterId: character.id, bindingId: binding.id,
      eventType: "PRIVATE_MESSAGE", externalConversationId: `c:${uid}`, externalMessageId, authorOpenId: uid, authorPlatformUid: uid,
      authorDisplayName: "合成联系人", speaker: { isOwner: false }, content, sendReply: async () => {},
    });
    assert.equal(result.status, "replied", JSON.stringify(result));
    if (result.status !== "replied") throw new Error("Fixture did not receive reply");
    return result.conversationId;
  };
  const firstId = `first-${randomUUID()}`, followId = `follow-${randomUUID()}`;
  const roomId = await send("222", "你对自己的认识是什么？", firstId);
  const firstReply = await db.message.findFirstOrThrow({ where: { conversationId: roomId, role: "ASSISTANT" } });
  assert.equal(firstReply.externalMessageId, null, "Use the actual stored shape of an assistant reply");
  assert(Array.isArray((firstReply.metadata as {providedSelfUnderstandingSources?:unknown}).providedSelfUnderstandingSources));
  const firstQuestion = await db.message.findFirstOrThrow({ where: { conversationId: roomId, externalMessageId: firstId } });
  await db.message.create({ data: { conversationId: roomId, role: "USER", content: "NULL_ID_HISTORY_SENTINEL", occurredAt: new Date(firstQuestion.occurredAt.getTime() - 1000) } });
  const followup = "这段时间有什么变化？有没有具体经历能说明？";
  assert.equal(await send("222", followup, followId), roomId);
  const second = requests[1]!;
  assert(second.recentMessages.some(row => row.role === "ASSISTANT" && row.content === "OWN_PRIOR_REPLY_SENTINEL"), "NULL platform IDs must not erase assistant history");
  assert(second.recentMessages.some(row => row.role === "USER" && row.content === "NULL_ID_HISTORY_SENTINEL"));
  assert(!second.recentMessages.some(row => row.content === followup), "Exclude the pre-recorded current input without excluding NULL history");
  assert(second.selfUnderstanding, "The real private pipeline must inherit the previous marked assistant reply");
  assert(Array.isArray((second.selfUnderstanding as { history?: unknown }).history), "A close retrospective follow-up should request historical evidence");
  assert.equal(await db.message.count({ where: { conversationId: roomId, externalMessageId: followId } }), 1);
  const secondReply = await db.message.findFirstOrThrow({ where: { conversationId: roomId, role: "ASSISTANT" }, orderBy: [{ occurredAt: "desc" }, { id: "desc" }] });
  assert.deepEqual((secondReply.metadata as {privateHistorySelection?:unknown}).privateHistorySelection,
    { version: 1, userRows: 2, assistantRows: 1 }, "Record counts only: no private text or message IDs in SQL-selection diagnostics");
  const otherRoomId = await send("333", "你对自己的认识是什么？", `other-${randomUUID()}`);
  assert.notEqual(otherRoomId, roomId);
  assert(!JSON.stringify(requests[2]).includes("OWN_PRIOR_REPLY_SENTINEL"));
  assert(!JSON.stringify(requests[2]).includes("NULL_ID_HISTORY_SENTINEL"));
  assert.equal(requests.length, 3, "No extra model classification is needed to retain the history");
  console.log("Private channel pipeline passed: pre-recorded current ID excluded, NULL assistant and USER history retained, actual two-turn follow-up inherits cognition, and another identity cannot read the history.");
} finally {
  if (model.listening) await new Promise<void>(resolve => model.close(() => resolve()));
  await db.$disconnect();
}
