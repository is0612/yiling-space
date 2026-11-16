import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { deleteChannelConnectionCompletely } from "../server/utils/channel-connection-delete";

/**
 * 「删除这个号」到底删干净了没有。
 *
 * 这个测试存在的理由：`character_channel_bindings.connectionId` 是 Restrict ——
 * 号上挂过角色之后，一句 `platformConnection.delete` 会被外键挡下来，
 * 用户看到的就是「加了个角色进来，这个号再也删不掉了」。
 * 所以第一个断言就是「有绑定的号也能删」，剩下的都是「删完没留孤儿行」。
 *
 * 同时验证两件**不该**被删的事：
 *   - 聊天记录（conversations / messages）：`channelBindingId` 是 SetNull，号没了历史还在；
 *   - 另一个号的数据不能连坐。
 */

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("缺少 DATABASE_URL，渠道连接删除测试无法运行。");

const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });

const ownerId = randomUUID();
const characterIds: string[] = [];
const connectionIds: string[] = [];

type Fixture = {
  connectionId: string;
  characterId: string;
  scopeId: string;
  bindingId: string;
  conversationId: string;
  groupActivityId: string;
  announcementId: string;
  qzoneActionId: string;
};

/** 一个号 + 一个角色绑上去 + 每种「没有外键」的行各造一条。 */
async function seedConnection(label: string, account: string): Promise<Fixture> {
  const connectionId = randomUUID();
  connectionIds.push(connectionId);
  await prisma.platformConnection.create({
    data: { id: connectionId, platform: "qq-onebot", displayName: `测试号-${label}`, platformAccountKey: account },
  });

  const characterId = randomUUID();
  characterIds.push(characterId);
  await prisma.character.create({
    data: { id: characterId, ownerId, name: `测试角色-${label}`, basePrompt: "你是测试角色。" },
  });

  const scopeId = randomUUID();
  await prisma.memoryScope.create({
    data: { id: scopeId, characterId, scopeType: "CHARACTER_GLOBAL", scopeKey: `character:${characterId}:global` },
  });

  const bindingId = randomUUID();
  await prisma.characterChannelBinding.create({
    data: { id: bindingId, characterId, connectionId, status: "ACTIVE", routingKey: "123456" },
  });

  const conversationId = randomUUID();
  await prisma.conversation.create({
    data: { id: conversationId, characterId, memoryScopeId: scopeId, channelBindingId: bindingId, externalConversationId: "g:123456" },
  });

  const groupActivityId = randomUUID();
  await prisma.groupActivity.create({
    data: {
      id: groupActivityId,
      channelBindingId: bindingId,
      characterId,
      externalConversationId: "g:123456",
      groupId: "123456",
      lastMessageAt: new Date(),
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
      topic: "测试公告",
      content: "测试公告内容",
      expiresAt: new Date(Date.now() + 3600_000),
    },
  });

  const qzoneActionId = randomUUID();
  await prisma.onebotQzoneAction.create({
    data: {
      id: qzoneActionId,
      connectionId,
      characterId,
      kind: "POST",
      content: "测试说说",
      topic: "测试",
      requestedBy: "10001",
      expiresAt: new Date(Date.now() + 3600_000),
    },
  });

  return { connectionId, characterId, scopeId, bindingId, conversationId, groupActivityId, announcementId, qzoneActionId };
}

async function main() {
  await prisma.user.create({
    data: { id: ownerId, username: `ch-del-${randomUUID().slice(0, 8)}`, passwordHash: "x", role: "ADMIN" },
  });

  const target = await seedConnection("要删的", "1700000001");
  const bystander = await seedConnection("隔壁号", "1700000002");

  // 同一个号上再挂一个角色：这正是「加第二个角色进来」的场景
  const secondCharacterId = randomUUID();
  characterIds.push(secondCharacterId);
  await prisma.character.create({
    data: { id: secondCharacterId, ownerId, name: "测试角色-第二个", basePrompt: "你是第二个测试角色。" },
  });
  const secondBindingId = randomUUID();
  await prisma.characterChannelBinding.create({
    data: { id: secondBindingId, characterId: secondCharacterId, connectionId: target.connectionId, status: "ACTIVE" },
  });

  const emptyConnectionId = randomUUID();
  connectionIds.push(emptyConnectionId);
  await prisma.platformConnection.create({
    data: { id: emptyConnectionId, platform: "qq-onebot", displayName: "测试号-空的", platformAccountKey: "1700000003" },
  });

  const purged = await deleteChannelConnectionCompletely({ connectionId: target.connectionId });
  assert.equal(purged.bindings, 2, "两条绑定都该跟着号一起删掉");
  assert.equal(purged.groupActivities, 1, "GroupActivity 没有外键，必须显式删");
  assert.equal(purged.announcements, 1, "公告草稿只带 connectionId，没有外键");
  assert.equal(purged.qzoneActions, 1, "空间动作只带 connectionId，没有外键");

  // ── 该消失的 ─────────────────────────────────────────
  assert.equal(await prisma.platformConnection.count({ where: { id: target.connectionId } }), 0, "号本身应该被删掉");
  assert.equal(
    await prisma.characterChannelBinding.count({ where: { connectionId: target.connectionId } }),
    0,
    "Restrict 外键：绑定必须先删，否则号删不掉",
  );
  assert.equal(await prisma.groupActivity.count({ where: { id: target.groupActivityId } }), 0, "群活跃度行不能留下");
  assert.equal(await prisma.onebotGroupAnnouncement.count({ where: { id: target.announcementId } }), 0, "公告草稿不能留下");
  assert.equal(await prisma.onebotQzoneAction.count({ where: { id: target.qzoneActionId } }), 0, "空间动作不能留下");

  // ── 该保留的：聊天记录不跟着号一起消失 ────────────────
  const conversation = await prisma.conversation.findUnique({ where: { id: target.conversationId } });
  assert.ok(conversation, "聊天记录应该保留（号没了不等于历史该消失）");
  assert.equal(conversation.channelBindingId, null, "绑定的外键应该被置空，而不是把会话删掉");
  assert.equal(
    await prisma.character.count({ where: { id: target.characterId } }),
    1,
    "删号不该删角色 —— 角色还可以绑别的号",
  );

  // ── 不能连坐 ─────────────────────────────────────────
  assert.equal(await prisma.platformConnection.count({ where: { id: bystander.connectionId } }), 1, "隔壁号不该被删");
  assert.equal(
    await prisma.characterChannelBinding.count({ where: { connectionId: bystander.connectionId } }),
    1,
    "隔壁号的绑定不该被删",
  );
  assert.equal(await prisma.groupActivity.count({ where: { id: bystander.groupActivityId } }), 1, "隔壁号的活跃度不该被删");

  // ── 空号（没有角色）也要能删 ──────────────────────────
  const emptyPurged = await deleteChannelConnectionCompletely({ connectionId: emptyConnectionId });
  assert.deepEqual(emptyPurged, { bindings: 0, groupActivities: 0, announcements: 0, qzoneActions: 0 });
  assert.equal(await prisma.platformConnection.count({ where: { id: emptyConnectionId } }), 0, "没绑角色的号应该能直接删掉");

  console.log("删渠道连接测试通过：有绑定的号能删掉，孤儿行清干净，聊天记录与隔壁号不受影响。");
}

try {
  await main();
} finally {
  await prisma.conversation.deleteMany({ where: { characterId: { in: characterIds } } }).catch(() => undefined);
  await prisma.memoryScope.deleteMany({ where: { characterId: { in: characterIds } } }).catch(() => undefined);
  await prisma.groupActivity.deleteMany({ where: { characterId: { in: characterIds } } }).catch(() => undefined);
  await prisma.onebotGroupAnnouncement.deleteMany({ where: { characterId: { in: characterIds } } }).catch(() => undefined);
  await prisma.onebotQzoneAction.deleteMany({ where: { characterId: { in: characterIds } } }).catch(() => undefined);
  await prisma.character.deleteMany({ where: { id: { in: characterIds } } }).catch(() => undefined);
  await prisma.platformConnection.deleteMany({ where: { id: { in: connectionIds } } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => undefined);
  await prisma.$disconnect();
}
