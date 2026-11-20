import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { PrismaClient } from "../src/generated/prisma/client";
import { handleRoleplayChannel, isRoleplayOwner, parseRoleplayCommand, resolveRoleplayTarget } from "../server/utils/roleplay-channel";
import { findDeliveryTarget } from "../server/utils/proactive";

export function testRoleplayChannelLogic() {
  assert.deepEqual(parseRoleplayCommand(" /扮演 开始 测试人设 "), { action: "start", target: "测试人设" });
  assert.deepEqual(parseRoleplayCommand("/扮演 退出"), { action: "exit", target: "" });
  assert.equal(parseRoleplayCommand("结束"), null);
  assert.equal(parseRoleplayCommand("我们来玩/扮演吧"), null);
  assert.equal(parseRoleplayCommand("/扮演模式"), null);
  assert.equal(parseRoleplayCommand("/扮演 状态 多余参数")?.action, "help");
  const items = [{ id: "abcdef01-1111", name: "同名" }, { id: "abcdef02-1111", name: "同名" }];
  assert.equal(resolveRoleplayTarget(items, "同名"), null);
  assert.equal(resolveRoleplayTarget(items, "abcdef01")?.id, items[0]!.id);
  assert.equal(resolveRoleplayTarget(items, "abc"), null);
  const binding = { characterId: "c", status: "ACTIVE", connection: { platform: "qq-onebot", metadata: { ownerQq: "123456789" } }, character: { status: "ACTIVE" } };
  const input = { platform: "qq-onebot", eventType: "PRIVATE_MESSAGE", authorUid: "123456789", conversationKey: "c:123456789" };
  assert(isRoleplayOwner(input, binding, "c"));
  assert(!isRoleplayOwner({ ...input, authorUid: "987654321" }, binding, "c"));
  assert(!isRoleplayOwner({ ...input, eventType: "GROUP_MESSAGE" }, binding, "c"));
  assert(!isRoleplayOwner(input, binding, "other"));
  assert(!isRoleplayOwner(input, { ...binding, connection: { ...binding.connection, metadata: {} } }, "c"));
  const serve = readFileSync(new URL("../server/utils/channel-adapter/onebot/serve.ts", import.meta.url), "utf8");
  assert(serve.indexOf("const roleplayResult = await handleRoleplayChannel") < serve.indexOf("return handleChannelMessage({"));
  assert(serve.indexOf("const roleplayResult = await handleRoleplayChannel") < serve.indexOf("if (canUseQzone && isQzoneConfirm"));
}

/** Run only inside the isolated temporary database test, never seed personal data. */
export async function testRoleplayChannelDatabase(db: PrismaClient, ownerId: string, characterId: string) {
  testRoleplayChannelLogic();
  const connection = await db.platformConnection.create({ data: { platform: "qq-onebot", displayName: "扮演隔离测试连接", metadata: { ownerQq: "123456789" } } });
  const binding = await db.characterChannelBinding.create({ data: { characterId, connectionId: connection.id } });
  const persona = await db.roleplayPersona.create({ data: { ownerId, name: "QQ测试身份", prompt: "只在测试存档中交谈。", opening: "测试开场" } });
  const replies: string[] = [];
  const base = { platform: "qq-onebot", eventType: "PRIVATE_MESSAGE", characterId, bindingId: binding.id, externalConversationId: "c:123456789", authorUid: "123456789", sendReply: async (text: string) => { replies.push(text); } };
  const call = (content: string, externalMessageId = randomUUID()) => handleRoleplayChannel({ ...base, content, externalMessageId }, db);
  const dailyBefore = await db.message.count();
  const startId = randomUUID();
  assert.equal((await call(`/扮演 开始 ${persona.id.slice(0, 8)}`, startId))?.status, "replied");
  const route = await db.roleplayRoute.findUniqueOrThrow({ where: { bindingId_externalConversationId: { bindingId: binding.id, externalConversationId: base.externalConversationId } } });
  assert.equal(route.ownerId, ownerId);
  const scope = await db.memoryScope.create({ data: { characterId, scopeType: "USER_PRIVATE", scopeKey: `roleplay-test:${randomUUID()}`, userId: ownerId } });
  await db.conversation.create({ data: { characterId, memoryScopeId: scope.id, channelBindingId: binding.id, externalConversationId: base.externalConversationId } });
  assert.equal(await findDeliveryTarget(characterId), null, "daily proactive messages must pause in the roleplay private window");
  assert.equal((await db.roleplaySession.findUniqueOrThrow({ where: { id: route.sessionId } })).messageCount, 1);
  await call(`/扮演 开始 ${persona.id.slice(0, 8)}`, startId);
  assert.equal(await db.roleplaySession.count({ where: { ownerId, personaId: persona.id } }), 1, "redelivery must not create another session");
  await call("/扮演 状态"); assert(replies.at(-1)!.includes(route.sessionId.slice(0, 8)));
  await call("/扮演 存档"); assert(replies.at(-1)!.includes(route.sessionId.slice(0, 8)));
  const outsider = await handleRoleplayChannel({ ...base, authorUid: "987654321", externalConversationId: "c:987654321", content: "/扮演 列表", externalMessageId: randomUUID() }, db);
  assert.equal(outsider, null);
  const group = await handleRoleplayChannel({ ...base, eventType: "GROUP_MESSAGE", content: "/扮演 列表", externalMessageId: randomUUID() }, db);
  assert.equal(group, null);
  await call("/扮演 退出");
  assert.equal(await db.roleplayRoute.count({ where: { bindingId: binding.id } }), 0);
  assert.equal(await db.roleplaySession.count({ where: { id: route.sessionId } }), 1, "exit retains archive");
  await call(`/扮演 继续 ${route.sessionId.slice(0, 8)}`);
  assert.equal((await db.roleplayRoute.findFirstOrThrow({ where: { bindingId: binding.id } })).sessionId, route.sessionId);
  const fetchBefore = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async (_url, init) => {
    requests++;
    const body = JSON.parse(String(init?.body));
    assert(Array.isArray(body.messages));
    assert(!JSON.stringify(body).includes("主人格私有证据"));
    return new Response(JSON.stringify({ choices: [{ message: { content: "QQ独立回复" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }), { status: 200 });
  };
  try {
    const messageId = randomUUID();
    await call("QQ扮演消息", messageId);
    await call("QQ扮演消息", messageId);
    assert.equal(requests, 1, "duplicate QQ message must not invoke model twice");
    assert.equal(await db.roleplayMessage.count({ where: { sessionId: route.sessionId, role: "user" } }), 1);
    assert.equal(replies.at(-1), "QQ独立回复");
  } finally { globalThis.fetch = fetchBefore; }
  assert.equal(await db.message.count(), dailyBefore, "roleplay commands and text must never enter daily messages");
  await db.roleplaySession.delete({ where: { id: route.sessionId } });
  assert.equal(await db.roleplayRoute.count({ where: { bindingId: binding.id } }), 0);
  console.log("Roleplay QQ isolation passed: owner auth, group exclusion, switch persistence, command redelivery, message replay, exit/archive retention, no daily storage.");
}
