import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { deleteCharacterCompletely, removeCharacterStickerDirs } from "../server/utils/character-delete";
import { saveStickerFile, stickerCharacterDir, stickerOriginalsDir } from "../server/utils/stickers";

/**
 * 删角色到底删干净了没有 —— 这是唯一值得测的点。
 *
 * 有外键的表断了就断，没人会写错；真正会漏的是**没有外键**的那几张
 * （chat_requests / group_activities / onebot_group_announcements）和磁盘上的表情包目录，
 * 它们删完不会报错，只是悄悄留下来。所以每张表都造一行，删完逐个查。
 *
 * 同时验证两件「不该删」的事：
 *   - 另一个角色的数据不能连坐；
 *   - token 账单（model_usages）故意保留，删角色不该抹掉已经产生的花费。
 */

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("缺少 DATABASE_URL，删角色测试无法运行。");

const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });

const ownerId = randomUUID();
const characterIds: string[] = [];
const connectionIds: string[] = [];
const dirs: string[] = [];
const auditLogIds: string[] = [];

type Fixture = {
  characterId: string;
  scopeId: string;
  conversationId: string;
  stickerId: string;
  chatRequestId: string;
  groupActivityId: string;
  announcementId: string;
  auditLogId: string;
  modelUsageId: string;
  catchphraseId: string;
  proactiveIntentId: string;
};

/** 给一个角色把「所有会被删的东西」各造一行。 */
async function seedCharacter(name: string): Promise<Fixture> {
  const characterId = randomUUID();
  characterIds.push(characterId);
  dirs.push(stickerCharacterDir(characterId), stickerOriginalsDir(characterId));

  await prisma.character.create({
    data: {
      id: characterId,
      ownerId,
      name,
      basePrompt: `你是${name}。`,
      memorySetting: { create: { timezone: "Asia/Shanghai" } },
    },
  });

  const connectionId = randomUUID();
  connectionIds.push(connectionId);
  await prisma.platformConnection.create({
    data: { id: connectionId, platform: "qq-onebot", displayName: `测试连接-${name}` },
  });
  const bindingId = randomUUID();
  await prisma.characterChannelBinding.create({
    data: { id: bindingId, characterId, connectionId },
  });

  const scopeId = randomUUID();
  await prisma.memoryScope.create({
    data: { id: scopeId, characterId, scopeType: "CHARACTER_GLOBAL", scopeKey: `character:${characterId}:global` },
  });

  const conversationId = randomUUID();
  await prisma.conversation.create({
    data: { id: conversationId, characterId, memoryScopeId: scopeId, title: "会话" },
  });
  await prisma.message.create({
    data: { conversationId, role: "USER", content: "在吗", occurredAt: new Date("2026-10-30T10:00:00Z") },
  });

  await prisma.memoryItem.create({
    data: { memoryScopeId: scopeId, category: "FACT", content: "一条记忆", importance: 0.5 },
  });

  // 表情包：库里一行 + 磁盘两张（图 + 原件备份）
  const fileName = await saveStickerFile(characterId, "png", Buffer.from("fake-png"));
  await fs.mkdir(stickerOriginalsDir(characterId), { recursive: true });
  await fs.writeFile(path.join(stickerOriginalsDir(characterId), fileName), Buffer.from("fake-original"));
  const stickerId = randomUUID();
  await prisma.characterSticker.create({
    data: {
      id: stickerId,
      characterId,
      name: "摸鱼",
      usage: "无聊的时候",
      fileName,
      mimeType: "image/png",
      sizeBytes: 8,
    },
  });

  const catchphraseId = randomUUID();
  await prisma.characterCatchphrase.create({
    data: { id: catchphraseId, characterId, phrase: "那你呢" },
  });

  const proactiveIntentId = randomUUID();
  await prisma.proactiveIntent.create({
    data: { id: proactiveIntentId, characterId, kind: "ASK", goal: "问他在干嘛", origin: "chat", dedupeKey: `k-${randomUUID()}` },
  });

  const chatRequestId = randomUUID();
  await prisma.chatRequest.create({
    data: {
      id: chatRequestId,
      ownerId,
      characterId,
      requestKey: randomUUID(),
      claimToken: randomUUID(),
      status: "DONE",
    },
  });

  const groupActivityId = randomUUID();
  await prisma.groupActivity.create({
    data: {
      id: groupActivityId,
      channelBindingId: bindingId,
      characterId,
      externalConversationId: `g:${randomUUID().slice(0, 8)}`,
      groupId: "123456",
      lastMessageAt: new Date("2026-10-30T10:00:00Z"),
    },
  });

  const announcementId = randomUUID();
  await prisma.onebotGroupAnnouncement.create({
    data: {
      id: announcementId,
      connectionId,
      groupId: "123456",
      requestedBy: "10001",
      characterId,
      topic: "周末活动",
      content: "周六下午三点",
      expiresAt: new Date("2026-11-30T10:00:00Z"),
    },
  });

  const auditLogId = randomUUID();
  auditLogIds.push(auditLogId);
  await prisma.auditLog.create({
    data: { id: auditLogId, actorType: "USER", actorId: ownerId, characterId, action: "character.updated", entityType: "Character", entityId: characterId },
  });

  const modelUsageId = randomUUID();
  await prisma.modelUsage.create({
    data: { id: modelUsageId, kind: "chat", model: "deepseek-chat", characterId, totalTokens: 100 },
  });

  return {
    characterId,
    scopeId,
    conversationId,
    stickerId,
    chatRequestId,
    groupActivityId,
    announcementId,
    auditLogId,
    modelUsageId,
    catchphraseId,
    proactiveIntentId,
  };
}

async function exists(dir: string): Promise<boolean> {
  return fs
    .stat(dir)
    .then(() => true)
    .catch(() => false);
}

async function main() {
  await prisma.user.create({
    data: { id: ownerId, username: `del-test-${randomUUID().slice(0, 8)}`, passwordHash: "x", role: "ADMIN" },
  });

  const target = await seedCharacter("要删的");
  const bystander = await seedCharacter("隔壁角色");

  // 前置断言：文件真的落盘了，否则后面的「删掉了」是假通过
  assert.equal(await exists(stickerCharacterDir(target.characterId)), true, "前置：表情包目录应该存在");
  assert.equal(await exists(stickerOriginalsDir(target.characterId)), true, "前置：原件备份目录应该存在");

  const result = await deleteCharacterCompletely({ characterId: target.characterId, ownerId });
  assert.ok(result, "删除应该返回结果，而不是 404");
  assert.equal(result.name, "要删的");
  assert.equal(result.removedStickerDirs, true, "应该真的删掉了磁盘目录");
  assert.equal(result.purged.chatRequests, 1);
  assert.equal(result.purged.groupActivities, 1);
  assert.equal(result.purged.announcements, 1);

  // ── 有外键的：应该跟着消失 ───────────────────────────
  const gone = [
    ["角色", await prisma.character.count({ where: { id: target.characterId } })],
    ["记忆范围", await prisma.memoryScope.count({ where: { characterId: target.characterId } })],
    ["会话", await prisma.conversation.count({ where: { id: target.conversationId } })],
    ["消息", await prisma.message.count({ where: { conversationId: target.conversationId } })],
    ["记忆", await prisma.memoryItem.count({ where: { memoryScopeId: target.scopeId } })],
    ["表情包行", await prisma.characterSticker.count({ where: { id: target.stickerId } })],
    ["梗", await prisma.characterCatchphrase.count({ where: { id: target.catchphraseId } })],
    ["主动意图", await prisma.proactiveIntent.count({ where: { id: target.proactiveIntentId } })],
    ["渠道绑定", await prisma.characterChannelBinding.count({ where: { characterId: target.characterId } })],
    ["记忆设置", await prisma.characterMemorySetting.count({ where: { characterId: target.characterId } })],
  ] as const;
  for (const [label, count] of gone) assert.equal(count, 0, `${label}应该被删掉，实际还剩 ${count} 条`);

  // ── 没有外键的：这是这个测试存在的理由 ────────────────
  const manual = [
    ["ChatRequest", await prisma.chatRequest.count({ where: { id: target.chatRequestId } })],
    ["GroupActivity", await prisma.groupActivity.count({ where: { id: target.groupActivityId } })],
    ["OnebotGroupAnnouncement", await prisma.onebotGroupAnnouncement.count({ where: { id: target.announcementId } })],
  ] as const;
  for (const [label, count] of manual) assert.equal(count, 0, `${label}没有外键，必须显式删除，实际还剩 ${count} 条`);

  // ── 磁盘 ─────────────────────────────────────────────
  assert.equal(await exists(stickerCharacterDir(target.characterId)), false, "表情包目录应该被删掉");
  assert.equal(await exists(stickerOriginalsDir(target.characterId)), false, "原件备份目录应该被删掉");

  // ── 故意保留的两类 ───────────────────────────────────
  const auditLog = await prisma.auditLog.findUnique({ where: { id: target.auditLogId } });
  assert.ok(auditLog, "审计日志不该被删（SetNull，留痕）");
  assert.equal(auditLog.characterId, null, "审计日志的 characterId 应该被置空");

  // 删除本身也要留痕：角色行都没了，只剩这一条能证明「她是什么时候没的」。
  const deleteLog = await prisma.auditLog.findFirst({
    where: { action: "character.deleted", entityId: target.characterId },
  });
  assert.ok(deleteLog, "删角色必须写一条 character.deleted 审计");
  assert.equal(deleteLog.characterId, null, "角色已删，审计的 characterId 只能是 null（靠 entityId 认人）");
  assert.equal((deleteLog.details as { name?: string } | null)?.name, "要删的", "审计里要留着角色名");

  assert.equal(
    await prisma.modelUsage.count({ where: { id: target.modelUsageId } }),
    1,
    "token 账单不该随角色删除而消失",
  );

  // ── 不能连坐 ─────────────────────────────────────────
  const guard = [
    ["隔壁角色", await prisma.character.count({ where: { id: bystander.characterId } })],
    ["隔壁记忆范围", await prisma.memoryScope.count({ where: { characterId: bystander.characterId } })],
    ["隔壁会话", await prisma.conversation.count({ where: { id: bystander.conversationId } })],
    ["隔壁表情包", await prisma.characterSticker.count({ where: { id: bystander.stickerId } })],
    ["隔壁 ChatRequest", await prisma.chatRequest.count({ where: { id: bystander.chatRequestId } })],
    ["隔壁 GroupActivity", await prisma.groupActivity.count({ where: { id: bystander.groupActivityId } })],
  ] as const;
  for (const [label, count] of guard) assert.equal(count, 1, `${label}不该被连坐删除`);
  assert.equal(await exists(stickerCharacterDir(bystander.characterId)), true, "隔壁角色的表情包目录不该被删");

  // ── 边界：重复删、别人的角色、非法 id ────────────────
  assert.equal(await deleteCharacterCompletely({ characterId: target.characterId, ownerId }), null, "重复删应该返回 null（404）");
  assert.equal(
    await deleteCharacterCompletely({ characterId: bystander.characterId, ownerId: randomUUID() }),
    null,
    "不是自己的角色不该被删",
  );
  assert.equal(
    await prisma.character.count({ where: { id: bystander.characterId } }),
    1,
    "越权删除请求不能真的删掉别人的角色",
  );
  await assert.rejects(() => removeCharacterStickerDirs("../../etc"), /拒绝删除非 uuid 目录/);

  console.log("删角色测试通过：没有外键的 3 张表、表情包目录都清掉了；审计留痕、账单、隔壁角色不受影响。");
}

try {
  await main();
} finally {
  // 收尾：清掉测试数据。目标角色已经删了，这里主要清隔壁角色和公用设施。
  await prisma.conversation.deleteMany({ where: { characterId: { in: characterIds } } }).catch(() => undefined);
  await prisma.memoryScope.deleteMany({ where: { characterId: { in: characterIds } } }).catch(() => undefined);
  await prisma.chatRequest.deleteMany({ where: { characterId: { in: characterIds } } }).catch(() => undefined);
  await prisma.groupActivity.deleteMany({ where: { characterId: { in: characterIds } } }).catch(() => undefined);
  await prisma.onebotGroupAnnouncement.deleteMany({ where: { characterId: { in: characterIds } } }).catch(() => undefined);
  await prisma.character.deleteMany({ where: { id: { in: characterIds } } }).catch(() => undefined);
  // 审计行是 SetNull，角色删了它还在 —— 不清就会污染真实的审计页面。
  await prisma.auditLog.deleteMany({ where: { OR: [{ entityId: { in: characterIds } }, { id: { in: auditLogIds } }] } }).catch(() => undefined);
  await prisma.modelUsage.deleteMany({ where: { characterId: { in: characterIds } } }).catch(() => undefined);
  await prisma.platformConnection.deleteMany({ where: { id: { in: connectionIds } } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => undefined);
  for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  await prisma.$disconnect();
}
