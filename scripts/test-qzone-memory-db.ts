import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { recordQzonePostMemory, qzoneConversationKey } from "../server/utils/qzone-memory";
import { conversationOriginLabel } from "../server/utils/conversation-message";

// 一次性库：造自己的角色与全局范围，结束时按外键顺序清干净。
const connectionString = process.env.DATABASE_URL ?? "";
assert.equal(process.env.YILING_CHAT_ISOLATED_DB, "1");
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const userId = randomUUID();
const characterId = randomUUID();
const scopeId = randomUUID();
const accountQq = "200000001";

try {
  await prisma.user.create({ data: { id: userId, username: `qzone-${userId}`, passwordHash: "synthetic-only" } });
  await prisma.character.create({ data: { id: characterId, ownerId: userId, name: "空间记忆角色", basePrompt: "synthetic-only" } });
  await prisma.memoryScope.create({ data: { id: scopeId, characterId, scopeType: "CHARACTER_GLOBAL", scopeKey: `g:${characterId}` } });

  // 1) 第一次发布：写进消息链路。
  const first = await recordQzonePostMemory(prisma, { characterId, accountQq, content: "今天下雨了，雨点像有人在天上撒豆子。", tid: "tid-1" });
  assert.equal(first.recorded, true);
  const conversation = await prisma.conversation.findFirstOrThrow({
    where: { channelBindingId: null, externalConversationId: qzoneConversationKey(accountQq) },
    select: { id: true, memoryScopeId: true, title: true, metadata: true },
  });
  assert.equal(conversation.memoryScopeId, scopeId, "空间消息挂在角色全局范围，才进得了同样的记忆流水线");
  assert.equal(conversation.title, `QQ空间 ${accountQq}`);
  assert.deepEqual(conversation.metadata, { kind: "qzone", qq: accountQq });
  const stored = await prisma.message.findFirstOrThrow({ where: { conversationId: conversation.id }, select: { role: true, content: true, metadata: true } });
  assert.equal(stored.role, "ASSISTANT", "她自己发的说说按助手消息记");
  assert.match(stored.content, /雨点/);
  assert.deepEqual(stored.metadata, { source: "qzone", kind: "qzone", qzoneTid: "tid-1" });

  // 2) 同一个 tid 重投：不重复记。
  const again = await recordQzonePostMemory(prisma, { characterId, accountQq, content: "今天下雨了，雨点像有人在天上撒豆子。", tid: "tid-1" });
  assert.deepEqual(again, { recorded: false, reason: "duplicate" });
  assert.equal(await prisma.message.count({ where: { conversationId: conversation.id } }), 1);

  // 3) 没有 tid 时按「同一天同一条正文」去重。
  const noTid = await recordQzonePostMemory(prisma, { characterId, accountQq, content: "月亮很圆。", tid: null });
  assert.equal(noTid.recorded, true);
  const noTidAgain = await recordQzonePostMemory(prisma, { characterId, accountQq, content: "月亮很圆。", tid: null });
  assert.deepEqual(noTidAgain, { recorded: false, reason: "duplicate" });

  // 4) 空正文 / 缺账号：不写。
  assert.deepEqual(await recordQzonePostMemory(prisma, { characterId, accountQq, content: "   ", tid: "tid-2" }), { recorded: false, reason: "empty_content" });
  assert.deepEqual(await recordQzonePostMemory(prisma, { characterId, accountQq: " ", content: "有内容", tid: "tid-3" }), { recorded: false, reason: "no_account" });

  // 5) 没有全局范围的角色：明确失败，不静默写到别处。
  const orphanCharacter = randomUUID();
  await prisma.character.create({ data: { id: orphanCharacter, ownerId: userId, name: "没有记忆范围", basePrompt: "synthetic-only" } });
  assert.deepEqual(
    await recordQzonePostMemory(prisma, { characterId: orphanCharacter, accountQq, content: "随便说说", tid: "tid-4" }),
    { recorded: false, reason: "no_scope" },
  );

  // 6) 来源标签：空间会话不该被显示成「本地对话」。
  assert.equal(conversationOriginLabel({ externalConversationId: qzoneConversationKey(accountQq) }), "QQ空间");
  assert.equal(conversationOriginLabel({ externalConversationId: "g:123456789" }), "QQ群 123456789");
  assert.equal(conversationOriginLabel({ externalConversationId: "c:123456789" }), "私聊");
  assert.equal(conversationOriginLabel({ externalConversationId: null }), "本地对话");

  console.log("空间说说进记忆通过：建会话与消息、tid 去重、无 tid 同日去重、空正文/缺账号/无范围拒绝、来源标签。");
} finally {
  await prisma.message.deleteMany({ where: { conversation: { characterId: { in: [characterId, ...[]] } } } });
  await prisma.conversation.deleteMany({ where: { characterId } });
  await prisma.memoryScope.deleteMany({ where: { characterId } });
  await prisma.character.deleteMany({ where: { ownerId: userId } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
}
