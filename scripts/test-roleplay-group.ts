import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "../src/generated/prisma/client";
import { handleRoleplayChannel } from "../server/utils/roleplay-channel";
import { createOnebotMessageHandler } from "../server/utils/channel-adapter/onebot/serve";
import { resolveOnebotEvent } from "../server/utils/channel-adapter/onebot/client";
import type { OnebotConnectionRecord } from "../server/utils/channel-adapter/onebot/configure";
import { GROUP_CHAT_DEFAULTS } from "../server/utils/channel-adapter/onebot/group-chat";

/** Runs only in test-roleplay-isolated's temporary database; no real QQ/model traffic. */
export async function testRoleplayGroupDatabase(db: PrismaClient, ownerId: string, characterId: string) {
  const ownerQq = "123456789";
  const memberQq = "987654321";
  const groups = ["g:111111111", "g:222222222"] as const;
  const connection = await db.platformConnection.create({ data: { platform: "qq-onebot", displayName: "群扮演隔离测试", metadata: { ownerQq } } });
  const binding = await db.characterChannelBinding.create({ data: { characterId, connectionId: connection.id } });
  const otherConnection = await db.platformConnection.create({ data: { platform: "qq-onebot", displayName: "另一绑定测试", metadata: { ownerQq } } });
  const otherBinding = await db.characterChannelBinding.create({ data: { characterId, connectionId: otherConnection.id } });
  const persona = await db.roleplayPersona.create({ data: { ownerId, name: `群测试身份${randomUUID().slice(0, 8)}`, prompt: "GROUP_PERSONA_ONLY：你是此独立测试对话中的角色。", opening: "独立测试开场" } });
  const replies: Array<{ conversation: string; text: string }> = [];
  const payloads: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  const originalFetch = globalThis.fetch;
  const settings = await db.roleplaySetting.findUniqueOrThrow({ where: { ownerId } });
  const dailyBefore = await db.message.count();
  await db.roleplaySetting.update({ where: { ownerId }, data: { recentMessageLimit: 40 } });
  const call = (conversation: string, content: string, options: { authorUid?: string; addressed?: boolean; messageId?: string; bindingId?: string } = {}) => handleRoleplayChannel({
    platform: "qq-onebot", eventType: conversation.startsWith("g:") ? "GROUP_MESSAGE" : "PRIVATE_MESSAGE", characterId,
    bindingId: options.bindingId ?? binding.id, externalConversationId: conversation,
    externalMessageId: options.messageId ?? randomUUID(), authorUid: options.authorUid ?? ownerQq,
    content, addressed: options.addressed ?? false,
    sendReply: async (text: string) => { replies.push({ conversation, text }); },
  }, db);
  const route = (conversation: string, bindingId = binding.id) => db.roleplayRoute.findUnique({ where: { bindingId_externalConversationId: { bindingId, externalConversationId: conversation } } });
  const users = (sessionId: string) => db.roleplayMessage.findMany({ where: { sessionId, role: "user" }, orderBy: { sequence: "asc" } });
  const lastReply = (conversation: string) => replies.filter(item => item.conversation === conversation).at(-1)?.text ?? "";
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(String(init?.body));
    payloads.push(payload);
    assert(Array.isArray(payload.messages));
    const text = JSON.stringify(payload);
    for (const account of [ownerQq, memberQq, "111111111", "222222222"]) assert(!text.includes(account), "model must receive anonymous aliases, not QQ/group identifiers");
    assert(!text.includes("Host identity must not leak"));
    assert(!text.includes("tools"));
    return new Response(JSON.stringify({ choices: [{ message: { content: "群测试模型回复" }, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 } }));
  };
  try {
    const privateKey = `c:${ownerQq}`;
    await call(privateKey, `&扮演 开始 ${persona.id}`);
    const privateRoute = await route(privateKey); assert(privateRoute);
    await call(privateKey, "PRIVATE_STORY_SENTINEL");
    const privateSession = await db.roleplaySession.findUniqueOrThrow({ where: { id: privateRoute.sessionId } });
    assert.equal(privateSession.groupBindingId, null);
    assert.equal(privateSession.groupConversationId, null);

    // Owner commands work without an @; a group member cannot start or inspect archives.
    await call(groups[0], `&扮演 开始 ${persona.id}`, { authorUid: memberQq, addressed: true });
    assert.equal(await route(groups[0]), null);
    const startId = randomUUID();
    await call(groups[0], `&扮演 开始 ${persona.id}`, { messageId: startId });
    const firstRoute = await route(groups[0]); assert(firstRoute, "bare owner command must start group roleplay");
    const groupSession = await db.roleplaySession.findUniqueOrThrow({ where: { id: firstRoute.sessionId } });
    assert.equal(groupSession.groupBindingId, binding.id);
    assert.equal(groupSession.groupConversationId, groups[0]);
    assert.notEqual(groupSession.id, privateRoute.sessionId);
    assert.equal(groupSession.summary, "");
    assert.equal(await db.roleplayMessage.count({ where: { sessionId: groupSession.id } }), 1, "group starts with only its own opening");
    await call(groups[0], `&扮演 开始 ${persona.id}`, { messageId: startId });
    assert.equal((await route(groups[0]))?.sessionId, groupSession.id);
    assert.equal(await db.roleplaySession.count({ where: { ownerId, personaId: persona.id, groupBindingId: binding.id, groupConversationId: groups[0] } }), 1, "command redelivery must not create duplicate group archives");

    // Reusing a platform message id in a second group must not replay the first group's receipt.
    await call(groups[1], `&扮演 开始 ${persona.id}`, { messageId: startId });
    const secondRoute = await route(groups[1]); assert(secondRoute);
    assert.notEqual(secondRoute.sessionId, firstRoute.sessionId);
    assert.equal((await db.roleplaySession.findUniqueOrThrow({ where: { id: secondRoute.sessionId } })).groupConversationId, groups[1]);

    await call(groups[0], "&扮演 存档");
    assert(lastReply(groups[0]).includes(firstRoute.sessionId.slice(0, 8)));
    assert(!lastReply(groups[0]).includes(privateRoute.sessionId.slice(0, 8)));
    assert(!lastReply(groups[0]).includes(secondRoute.sessionId.slice(0, 8)));
    await call(privateKey, "&扮演 存档");
    assert(lastReply(privateKey).includes(privateRoute.sessionId.slice(0, 8)));
    assert(!lastReply(privateKey).includes(firstRoute.sessionId.slice(0, 8)));

    const callsBeforeDenied = payloads.length;
    const repliesBeforeDenied = replies.length;
    await call(groups[0], "&扮演 存档", { authorUid: memberQq, addressed: true });
    for (const item of replies.slice(repliesBeforeDenied)) {
      assert(!item.text.includes(privateRoute.sessionId.slice(0, 8)));
      assert(!item.text.includes(firstRoute.sessionId.slice(0, 8)));
      assert(!item.text.includes(secondRoute.sessionId.slice(0, 8)));
    }
    await call(groups[0], "&扮演 退出", { authorUid: memberQq, addressed: true });
    await call(groups[0], `&扮演 继续 ${secondRoute.sessionId}`, { authorUid: memberQq, addressed: true });
    assert.equal((await route(groups[0]))?.sessionId, firstRoute.sessionId);
    assert.equal(payloads.length, callsBeforeDenied, "member commands must never invoke model");

    // Scope remains immutable: neither complete UUID nor prefix bypasses channel restrictions.
    for (const target of [privateRoute.sessionId, secondRoute.sessionId]) {
      await call(groups[0], `&扮演 继续 ${target}`);
      assert.equal((await route(groups[0]))?.sessionId, firstRoute.sessionId);
    }
    await call(privateKey, `&扮演 继续 ${firstRoute.sessionId}`);
    assert.equal((await route(privateKey))?.sessionId, privateRoute.sessionId);
    await call(groups[0], `&扮演 继续 ${firstRoute.sessionId}`, { bindingId: otherBinding.id });
    assert.equal(await route(groups[0], otherBinding.id), null, "same group under another binding is a different scope");
    const unchanged = await db.roleplaySession.findUniqueOrThrow({ where: { id: firstRoute.sessionId } });
    assert.equal(unchanged.groupBindingId, binding.id);
    assert.equal(unchanged.groupConversationId, groups[0]);

    const callsBeforeSilent = payloads.length;
    const rowsBeforeSilent = await db.roleplayMessage.count({ where: { sessionId: firstRoute.sessionId } });
    const silent = await call(groups[0], "未点名的背景闲聊", { authorUid: memberQq });
    assert.equal(silent?.status, "ignored");
    assert.equal(payloads.length, callsBeforeSilent);
    assert.equal(await db.roleplayMessage.count({ where: { sessionId: firstRoute.sessionId } }), rowsBeforeSilent);

    const sharedMessageId = randomUUID();
    await call(groups[0], "GROUP_A_STORY_SENTINEL", { authorUid: memberQq, addressed: true, messageId: sharedMessageId });
    const firstGroupPayload = payloads.at(-1)!;
    assert(!JSON.stringify(firstGroupPayload).includes("PRIVATE_STORY_SENTINEL"));
    const firstUsers = await users(firstRoute.sessionId);
    assert.equal(firstUsers.length, 1);
    assert(firstUsers[0]!.content.endsWith("GROUP_A_STORY_SENTINEL"));
    assert.notEqual(firstUsers[0]!.content, "GROUP_A_STORY_SENTINEL", "group turn must include anonymous speaker prefix");
    assert(!firstUsers[0]!.content.includes(memberQq));
    const aliasPrefix = firstUsers[0]!.content.slice(0, -"GROUP_A_STORY_SENTINEL".length);
    assert(aliasPrefix.trim().length > 0);
    const afterFirstCalls = payloads.length;
    await call(groups[0], "GROUP_A_STORY_SENTINEL", { authorUid: memberQq, addressed: true, messageId: sharedMessageId });
    assert.equal(payloads.length, afterFirstCalls, "duplicate group turn must reuse response");
    assert.equal((await users(firstRoute.sessionId)).length, 1);

    await call(groups[1], "GROUP_B_STORY_SENTINEL", { authorUid: memberQq, addressed: true, messageId: sharedMessageId });
    const secondUsers = await users(secondRoute.sessionId);
    assert.equal(secondUsers.length, 1);
    assert.notEqual(firstUsers[0]!.requestId, secondUsers[0]!.requestId, "message id scope must include conversation, not only binding");
    assert(!JSON.stringify(payloads.at(-1)).includes("GROUP_A_STORY_SENTINEL"));
    assert(!JSON.stringify(payloads.at(-1)).includes("PRIVATE_STORY_SENTINEL"));

    await call(groups[0], "GROUP_A_SECOND_TURN", { authorUid: memberQq, addressed: true });
    const sameSpeaker = (await users(firstRoute.sessionId)).at(-1)!;
    assert.equal(sameSpeaker.content.slice(0, -"GROUP_A_SECOND_TURN".length), aliasPrefix, "same member keeps a stable anonymous alias");
    await call(groups[0], "GROUP_A_OWNER_TURN", { addressed: true });
    const ownerTurn = (await users(firstRoute.sessionId)).at(-1)!;
    assert.notEqual(ownerTurn.content.slice(0, -"GROUP_A_OWNER_TURN".length), aliasPrefix, "different members must have distinct aliases");

    // Exit is local to this binding/group and retains the story for a later explicit resume.
    await call(groups[0], "&扮演 退出");
    assert.equal(await route(groups[0]), null);
    assert.equal((await route(privateKey))?.sessionId, privateRoute.sessionId);
    assert.equal((await route(groups[1]))?.sessionId, secondRoute.sessionId);
    assert(await db.roleplaySession.findUnique({ where: { id: firstRoute.sessionId } }));
    await call(groups[0], `&扮演 继续 ${firstRoute.sessionId}`);
    assert.equal((await route(groups[0]))?.sessionId, firstRoute.sessionId);
    const beforeFinalExit = payloads.length;
    await call(groups[0], "&扮演 退出");
    assert.equal(await call(groups[0], "退出后的正常群消息", { addressed: true }), null);
    assert.equal(payloads.length, beforeFinalExit);
    assert.equal(await db.message.count(), dailyBefore, "group roleplay must not write daily message records");
    await testRoleplayGroupAdapter(db, ownerId, characterId, persona.id);
    console.log("Roleplay group DB tests passed: bare owner commands, member permissions, immutable binding/group archives, private/group isolation, anonymous speakers, addressed gate, cross-group idempotency and independent exit.");
  } finally {
    globalThis.fetch = originalFetch;
    await db.roleplaySetting.update({ where: { ownerId }, data: { recentMessageLimit: settings.recentMessageLimit } });
  }
}

async function testRoleplayGroupAdapter(db: PrismaClient, ownerId: string, characterId: string, personaId: string) {
  const selfQq = "555555555";
  const ownerQq = "123456789";
  const memberQq = "987654321";
  const groupId = "333333333";
  const connection = await db.platformConnection.create({ data: { platform: "qq-onebot", displayName: "群扮演真实adapter测试", metadata: { ownerQq } } });
  const binding = await db.characterChannelBinding.create({ data: { characterId, connectionId: connection.id, routingKey: groupId } });
  const character = await db.character.findUniqueOrThrow({ where: { id: characterId } });
  if (!await db.memoryScope.findFirst({ where: { characterId, scopeType: "CHARACTER_GLOBAL" } })) await db.memoryScope.create({ data: { characterId, scopeType: "CHARACTER_GLOBAL", scopeKey: `adapter-group:${randomUUID()}` } });
  const bindingRecord = { id: binding.id, characterId, characterName: character.name, routingKey: groupId,
    replyWindowMinutes: 10, replyLimitPerWindow: 0, replyOnlyWhenMentioned: true,
    groupChat: { ...GROUP_CHAT_DEFAULTS, mode: "all" as const, mentionWindowSeconds: 0.3, batchWindowSeconds: 0.3, minGapSeconds: 0, quietStart: "", quietEnd: "" }, groupChatModes: {}, storeAmbientGroupMessages: false };
  const record: OnebotConnectionRecord = { id: connection.id, platform: "qq-onebot", accountQq: selfQq,
    config: { wsUrl: "ws://127.0.0.1:4999", httpUrl: "http://127.0.0.1:4998" }, replyOnlyWhenMentioned: true,
    groupAnnouncementEnabled: false,
    ownerQq, ownerName: "测试主人", snowlumaPassword: "", bindings: [bindingRecord] };
  const handler = createOnebotMessageHandler(record);
  const event = (text: string, at = false, uid = memberQq) => {
    const result = resolveOnebotEvent({ post_type: "message", message_type: "group", self_id: Number(selfQq),
      message_id: randomUUID(), user_id: Number(uid), group_id: Number(groupId),
      sender: { user_id: Number(uid), nickname: "测试成员", role: "member" },
      message: [...(at ? [{ type: "at", data: { qq: selfQq } }] : []), { type: "text", data: { text } }] });
    assert(result); return result;
  };
  const originalFetch = globalThis.fetch;
  let modelCalls = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const sent: Array<Record<string, unknown>> = [];
  let failNextSend = false;
  globalThis.fetch = async (url, init) => {
    const address = String(url);
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (address.includes("/send_group_msg")) {
      sent.push(body);
      assert.equal(String(body.group_id), groupId);
      if (failNextSend) { failNextSend = false; throw new Error("mock QQ transport failed"); }
      return new Response(JSON.stringify({ status: "ok", retcode: 0, data: { message_id: sent.length } }));
    }
    assert(address.includes("/chat/completions"), `unexpected adapter network request: ${address}`);
    modelCalls++; inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      const payload = JSON.stringify(body);
      assert(!payload.includes("DAILY_BUFFER_SENTINEL"), "old daily batch must not enter roleplay model history");
      assert(!payload.includes(ownerQq)); assert(!payload.includes(memberQq)); assert(!payload.includes(selfQq));
      await new Promise(resolve => setTimeout(resolve, 15));
      return new Response(JSON.stringify({ choices: [{ message: { content: "真实adapter模拟回复" }, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 } }));
    } finally { inFlight--; }
  };
  const dailyBefore = await db.message.count();
  try {
    // Buffer a real ordinary group event first; its timer fires only after explicit roleplay starts.
    const buffered = await handler(event("DAILY_BUFFER_SENTINEL", true, ownerQq));
    assert.equal(buffered.status, "buffered");
    const start = await handler(event(`&扮演 开始 ${personaId}`, false, ownerQq));
    assert.equal(start.status, "replied", "owner must start with bare command through actual adapter");
    const active = await db.roleplayRoute.findUniqueOrThrow({ where: { bindingId_externalConversationId: { bindingId: binding.id, externalConversationId: `g:${groupId}` } } });
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(modelCalls, 0, "pre-switch daily flush must not call a model");
    assert.equal(await db.message.count(), dailyBefore, "pre-switch daily flush must not write normal message rows");
    const beforeIgnored = sent.length;
    const ignored = await handler(event("未点名的普通群聊"));
    assert.equal(ignored.status, "ignored");
    assert.equal(modelCalls, 0); assert.equal(sent.length, beforeIgnored);

    const addressed = await handler(event("真实at测试", true));
    assert.equal(addressed.status, "replied");
    assert.equal(modelCalls, 1);
    assert.equal((await db.roleplayMessage.findFirstOrThrow({ where: { sessionId: active.sessionId, role: "user" } })).content.endsWith("真实at测试"), true);
    const concurrent = await Promise.all([handler(event("并发群消息甲", true)), handler(event("并发群消息乙", true))]);
    assert(concurrent.every(result => result.status === "replied"));
    assert.equal(modelCalls, 3, "adapter must serialize two addressed turns, not return a session lease error");
    assert.equal(maxInFlight, 1);
    assert.equal(await db.roleplayMessage.count({ where: { sessionId: active.sessionId, role: "assistant", source: "qq-group" } }), 3);
    assert.equal(sent.length, 4, "start confirmation plus exactly three model replies");
    const modelReplyBodies = sent.slice(1).map(body => JSON.stringify(body));
    assert(modelReplyBodies.every(body => body.includes("真实adapter模拟回复")), "parallel replies must not be lease error text");

    // Existing qq-group replies count in the same rolling window as ordinary group replies.
    bindingRecord.replyLimitPerWindow = 1;
    let callsBeforeLimit = modelCalls;
    const limited = await handler(event("窗口内应限流", true));
    assert.equal(limited.status, "ignored");
    assert("reason" in limited && limited.reason === "group_reply_limit");
    assert.equal(modelCalls, callsBeforeLimit);
    await db.roleplayMessage.updateMany({ where: { sessionId: active.sessionId, role: "assistant", source: "qq-group" }, data: { createdAt: new Date(Date.now() - 5 * 60_000) } });
    bindingRecord.replyWindowMinutes = 1;
    assert.equal((await handler(event("一分钟外可回复", true))).status, "replied");
    assert.equal(modelCalls, callsBeforeLimit + 1);
    await db.roleplayMessage.updateMany({ where: { sessionId: active.sessionId, role: "assistant", source: "qq-group" }, data: { createdAt: new Date(Date.now() - 5 * 60_000) } });
    bindingRecord.replyWindowMinutes = 10;
    callsBeforeLimit = modelCalls;
    assert.equal((await handler(event("十分钟内仍限流", true))).status, "ignored");
    assert.equal(modelCalls, callsBeforeLimit);

    // Completed replies can be resent after transport failure even when generation filled quota.
    await db.roleplayMessage.updateMany({ where: { sessionId: active.sessionId, role: "assistant" }, data: { createdAt: new Date(Date.now() - 20 * 60_000) } });
    const failedTurn = event("发送失败重投", true);
    failNextSend = true;
    const beforeTransport = modelCalls;
    await assert.rejects(handler(failedTurn));
    assert.equal(modelCalls, beforeTransport + 1);
    assert.equal((await handler(failedTurn)).status, "replied");
    assert.equal(modelCalls, beforeTransport + 1, "transport replay bypasses quotas without another model call");
    const blocked = await db.externalIdentity.upsert({ where: { platform_platformUid: { platform: "qq-onebot", platformUid: memberQq } }, create: { platform: "qq-onebot", platformUid: memberQq }, update: {} });
    const blockedScope = await db.memoryScope.create({ data: { characterId, scopeType: "EXTERNAL_IDENTITY", externalIdentityId: blocked.id, scopeKey: `blocked-replay-test:${randomUUID()}`, friendChatPolicy: "BLOCK" } });
    const beforeMemberCommand = sent.length;
    await handler(event("&扮演 状态", true));
    assert.equal(sent.length, beforeMemberCommand, "non-owner commands stay silent, including blocked members");
    await db.memoryScope.delete({ where: { id: blockedScope.id } });
    await handler(event(`&扮演 开始 ${personaId}`, false, ownerQq));
    const beforeOldReplay = modelCalls;
    assert.equal((await handler(failedTurn)).status, "duplicate");
    assert.equal(modelCalls, beforeOldReplay);

    // An @ segment before a command must be stripped by the production parser.
    assert.equal((await handler(event("&扮演 退出", true, ownerQq))).status, "replied");
    assert.equal(await db.roleplayRoute.count({ where: { bindingId: binding.id } }), 0);
    const beforeExitReplay = sent.length;
    assert.equal((await handler(failedTurn)).status, "duplicate");
    assert.equal(sent.length, beforeExitReplay);
    assert.equal(await db.message.count(), dailyBefore);
    bindingRecord.replyLimitPerWindow = 0;
    bindingRecord.groupChat.dailyMax = 1;
    Object.assign(bindingRecord.groupChat, { mode: "ambient" });
    const beforeDaily = modelCalls;
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
    try {
      await handler(event("退出后仍受每日上限", true, ownerQq));
      await new Promise(resolve => setTimeout(resolve, 500));
    } finally { console.log = originalLog; }
    assert(logs.some(line => line.includes('"reason":"daily_limit"')), "normal flush must hit daily gate using prior roleplay replies");
    assert.equal(modelCalls, beforeDaily, "normal flush includes roleplay replies in daily cap");
    assert.equal(await db.roleplaySession.count({ where: { ownerId, id: active.sessionId } }), 1);
    console.log("Roleplay adapter integration passed: real at segments, owner bare switches, silent gate, queued concurrent turns, stale daily flush cancellation and rolling reply limits.");
  } finally { globalThis.fetch = originalFetch; }
}
