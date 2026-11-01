import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";

// 删会话的回归测试：消息跟着会话走，记忆不能跟着走。
//
// 这条约束靠 prisma/schema.prisma 里的 onDelete 保证（MemoryItem.sourceMessageId 与
// MemorySnapshotSource.messageId 都是 SetNull），不是靠接口里写补偿逻辑 —— 所以这里
// 直接压数据库层：只要有人把 SetNull 改成 Cascade，测试立刻红。
// 只用自己造的记录，finally 里全部清掉。
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("缺少 DATABASE_URL。");
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

const suffix = randomUUID();
const userId = randomUUID();
const characterId = randomUUID();
const scopeId = randomUUID();

try {
  await prisma.user.create({ data: { id: userId, username: `del-test-${suffix}`, passwordHash: "integration-test-only" } });
  await prisma.character.create({
    data: {
      id: characterId,
      ownerId: userId,
      name: "删会话测试角色",
      basePrompt: "integration test",
      memoryScopes: { create: [{ id: scopeId, scopeType: "CHARACTER_GLOBAL", scopeKey: `character:${characterId}:global` }] },
    },
  });

  const conversation = await prisma.conversation.create({
    data: { characterId, memoryScopeId: scopeId, title: "待删会话", status: "ACTIVE" },
  });
  const userMessage = await prisma.message.create({
    data: { conversationId: conversation.id, role: "USER", content: "我住在杭州", occurredAt: new Date() },
  });
  const assistantMessage = await prisma.message.create({
    data: { conversationId: conversation.id, role: "ASSISTANT", content: "记住了", occurredAt: new Date() },
  });

  const memory = await prisma.memoryItem.create({
    data: {
      memoryScopeId: scopeId,
      category: "FACT",
      content: "用户住在杭州",
      sourceMessageId: userMessage.id,
    },
  });
  const snapshot = await prisma.memorySnapshot.create({
    data: {
      snapshotKey: `snapshot-${suffix}`,
      memoryScopeId: scopeId,
      periodStart: new Date(Date.now() - 3600_000),
      periodEnd: new Date(),
      summary: "聊到居住地",
      structuredContent: {},
      status: "CURRENT",
    },
  });
  const snapshotSource = await prisma.memorySnapshotSource.create({
    data: { snapshotId: snapshot.id, sourceType: "MESSAGE", sourceRef: assistantMessage.id, messageId: assistantMessage.id },
  });

  // 接口里用的就是这两个关系过滤，删除前先确认它们数得对
  const [countBeforeMemories, countBeforeSources] = await Promise.all([
    prisma.memoryItem.count({ where: { sourceMessage: { conversationId: conversation.id }, status: { not: "TRASHED" } } }),
    prisma.memorySnapshotSource.count({ where: { message: { conversationId: conversation.id } } }),
  ]);
  assert.equal(countBeforeMemories, 1, "删除前应数到 1 条记忆");
  assert.equal(countBeforeSources, 1, "删除前应数到 1 条快照来源");

  await prisma.conversation.delete({ where: { id: conversation.id } });

  const [leftMessages, leftMemory, leftSource, leftSnapshot] = await Promise.all([
    prisma.message.count({ where: { conversationId: conversation.id } }),
    prisma.memoryItem.findUnique({ where: { id: memory.id } }),
    prisma.memorySnapshotSource.findUnique({ where: { id: snapshotSource.id } }),
    prisma.memorySnapshot.findUnique({ where: { id: snapshot.id } }),
  ]);

  assert.equal(leftMessages, 0, "会话下的消息应被级联删除");
  assert.ok(leftMemory, "记忆条目必须还在");
  assert.equal(leftMemory.sourceMessageId, null, "记忆的来源指针应被置空而不是连带删除");
  assert.equal(leftMemory.content, "用户住在杭州", "记忆内容不能被改动");
  assert.ok(leftSnapshot, "快照必须还在");
  assert.ok(leftSource, "快照来源记录必须还在");
  assert.equal(leftSource.messageId, null, "快照来源指针同样只置空");

  console.log("通过：删会话 → 消息清空，记忆条目 / 快照 / 快照来源全部保留，来源指针置空。");
} finally {
  await prisma.memoryItem.deleteMany({ where: { memoryScopeId: scopeId } });
  await prisma.memorySnapshotSource.deleteMany({ where: { snapshot: { memoryScopeId: scopeId } } });
  await prisma.memorySnapshot.deleteMany({ where: { memoryScopeId: scopeId } });
  await prisma.memoryJob.deleteMany({ where: { memoryScopeId: scopeId } });
  await prisma.conversation.deleteMany({ where: { characterId } });
  await prisma.memoryScope.deleteMany({ where: { characterId } });
  await prisma.character.deleteMany({ where: { id: characterId } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
}
