import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { backfillQzonePostMemories, recordQzonePostMemory, qzoneConversationKey } from "../server/utils/qzone-memory";
import { conversationOriginLabel } from "../server/utils/conversation-message";

// 一次性库：造自己的角色、全局范围与连接，结束时按外键顺序清干净。
const connectionString = process.env.DATABASE_URL ?? "";
assert.equal(process.env.YILING_CHAT_ISOLATED_DB, "1");
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const userId = randomUUID();
const characterA = randomUUID();
const characterB = randomUUID();
const scopeA = randomUUID();
const scopeB = randomUUID();
const connectionId = randomUUID();
const accountQq = "200000001";

try {
  await prisma.user.create({ data: { id: userId, username: `qzone-${userId}`, passwordHash: "synthetic-only" } });
  await prisma.character.createMany({ data: [
    { id: characterA, ownerId: userId, name: "空间角色甲", basePrompt: "synthetic-only" },
    { id: characterB, ownerId: userId, name: "空间角色乙", basePrompt: "synthetic-only" },
  ] });
  await prisma.memoryScope.createMany({ data: [
    { id: scopeA, characterId: characterA, scopeType: "CHARACTER_GLOBAL", scopeKey: `g:${characterA}` },
    { id: scopeB, characterId: characterB, scopeType: "CHARACTER_GLOBAL", scopeKey: `g:${characterB}` },
  ] });
  await prisma.platformConnection.create({ data: {
    id: connectionId, platform: "qq-onebot", displayName: "空间小号", platformAccountKey: accountQq,
    metadata: { qqNumber: accountQq },
  } });

  // 1) 第一次发布：写进消息链路。
  const first = await recordQzonePostMemory(prisma, { characterId: characterA, accountQq, actionId: "action-1", content: "今天下雨了，雨点像有人在天上撒豆子。" });
  assert.equal(first.recorded, true);
  const conversationA = await prisma.conversation.findFirstOrThrow({
    where: { characterId: characterA, externalConversationId: qzoneConversationKey(accountQq) },
    select: { id: true, memoryScopeId: true, metadata: true, channelBindingId: true },
  });
  assert.equal(conversationA.memoryScopeId, scopeA);
  assert.equal(conversationA.channelBindingId, null, "空间会话不能挂绑定，否则会混进渠道页面");
  assert.deepEqual(conversationA.metadata, { kind: "qzone", qq: accountQq });
  const stored = await prisma.message.findFirstOrThrow({ where: { conversationId: conversationA.id }, select: { role: true, content: true, metadata: true } });
  assert.equal(stored.role, "ASSISTANT");
  assert.deepEqual(stored.metadata, { source: "qzone", kind: "qzone", qzoneActionId: "action-1" });

  // 2) 同一个动作重投：不重复记。
  assert.deepEqual(
    await recordQzonePostMemory(prisma, { characterId: characterA, accountQq, actionId: "action-1", content: "今天下雨了，雨点像有人在天上撒豆子。" }),
    { recorded: false, reason: "duplicate" },
  );

  // 3) 正文相同但是两次不同的发布：两条都记（动作 ID 不同）。
  const second = await recordQzonePostMemory(prisma, { characterId: characterA, accountQq, actionId: "action-2", content: "今天下雨了，雨点像有人在天上撒豆子。" });
  assert.equal(second.recorded, true, "同样的正文发两次是两件真事，不能被去重吞掉");
  assert.equal(await prisma.message.count({ where: { conversationId: conversationA.id } }), 2);

  // 4) 同一个 QQ 挂到另一个角色：各写各的会话，不串号。
  await recordQzonePostMemory(prisma, { characterId: characterB, accountQq, actionId: "action-b1", content: "另一个角色发的说说。" });
  const conversationB = await prisma.conversation.findFirstOrThrow({
    where: { characterId: characterB, externalConversationId: qzoneConversationKey(accountQq) },
    select: { id: true, memoryScopeId: true },
  });
  assert.notEqual(conversationB.id, conversationA.id, "同一个 QQ 在两个角色下必须是两个会话");
  assert.equal(conversationB.memoryScopeId, scopeB);
  assert.equal(await prisma.message.count({ where: { conversationId: conversationA.id } }), 2, "乙角色的说说不能写进甲角色");

  // 5) 只记公开可见的。
  assert.deepEqual(
    await recordQzonePostMemory(prisma, { characterId: characterA, accountQq, actionId: "action-friends", content: "好友可见的说说", visible: 4 }),
    { recorded: false, reason: "not_public" },
  );
  assert.deepEqual(
    await recordQzonePostMemory(prisma, { characterId: characterA, accountQq, actionId: "action-self", content: "仅自己可见的说说", visible: 64 }),
    { recorded: false, reason: "not_public" },
  );

  // 6) 缺动作 ID / 空正文 / 缺账号 / 没全局范围：都明确拒绝。
  assert.deepEqual(await recordQzonePostMemory(prisma, { characterId: characterA, accountQq, actionId: " ", content: "有内容" }), { recorded: false, reason: "no_action" });
  assert.deepEqual(await recordQzonePostMemory(prisma, { characterId: characterA, accountQq, actionId: "a", content: "   " }), { recorded: false, reason: "empty_content" });
  assert.deepEqual(await recordQzonePostMemory(prisma, { characterId: characterA, accountQq: " ", actionId: "a", content: "有内容" }), { recorded: false, reason: "no_account" });
  const noScopeCharacter = randomUUID();
  await prisma.character.create({ data: { id: noScopeCharacter, ownerId: userId, name: "没有记忆范围", basePrompt: "synthetic-only" } });
  assert.deepEqual(
    await recordQzonePostMemory(prisma, { characterId: noScopeCharacter, accountQq, actionId: "a", content: "随便说说" }),
    { recorded: false, reason: "no_scope" },
  );

  // 7) 补记：已经发布成功、但没进消息链路的说说（模拟当年只写了动作台账）。
  const legacyAction = await prisma.onebotQzoneAction.create({
    data: {
      connectionId, characterId: characterA, kind: "POST", content: "补记用的旧说说", topic: "旧说说",
      requestedBy: accountQq, status: "PUBLISHED", visible: 1,
      expiresAt: new Date(Date.now() + 60_000), publishedAt: new Date("2026-11-20T10:00:00Z"),
    },
    select: { id: true },
  });
  const before = await prisma.message.count({ where: { conversationId: conversationA.id } });
  const dry = await backfillQzonePostMemories(prisma, { characterId: characterA, connectionId, apply: false });
  assert.equal(dry.scanned, 1, "只扫 PUBLISHED 的 POST");
  assert.equal(dry.recorded, 0, "预演不写库");
  assert.equal(dry.wouldRecord.length, 1, "预演要报出会补哪条");
  assert.equal(await prisma.message.count({ where: { conversationId: conversationA.id } }), before, "预演不能留下消息");
  const applied = await backfillQzonePostMemories(prisma, { characterId: characterA, connectionId, apply: true });
  assert.equal(applied.recorded, 1, "补记写进了同一条空间会话");
  const again = await backfillQzonePostMemories(prisma, { characterId: characterA, connectionId, apply: true });
  assert.equal(again.recorded, 0, "重复补记不再写第二条");
  assert.equal(again.skipped, 1);
  assert.equal(await prisma.message.count({ where: { conversationId: conversationA.id } }), before + 1);
  assert(await prisma.message.findFirst({ where: { conversationId: conversationA.id, metadata: { path: ["qzoneActionId"], equals: legacyAction.id } } }));

  // 8) 来源标签：空间会话不该被显示成「本地对话」。
  assert.equal(conversationOriginLabel({ externalConversationId: qzoneConversationKey(accountQq) }), "QQ空间");
  assert.equal(conversationOriginLabel({ externalConversationId: "g:123456789" }), "QQ群 123456789");
  assert.equal(conversationOriginLabel({ externalConversationId: "c:123456789" }), "私聊");
  assert.equal(conversationOriginLabel({ externalConversationId: null }), "本地对话");

  console.log("空间说说进记忆通过：角色隔离、动作 ID 幂等、同正文两次都记、非公开与缺参数拒绝、补记可重跑、来源标签。");
} finally {
  await prisma.message.deleteMany({ where: { conversation: { characterId: { in: [characterA, characterB] } } } });
  await prisma.conversation.deleteMany({ where: { characterId: { in: [characterA, characterB] } } });
  await prisma.onebotQzoneAction.deleteMany({ where: { connectionId } });
  await prisma.platformConnection.deleteMany({ where: { id: connectionId } });
  await prisma.memoryScope.deleteMany({ where: { characterId: { in: [characterA, characterB] } } });
  await prisma.character.deleteMany({ where: { ownerId: userId } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
}
