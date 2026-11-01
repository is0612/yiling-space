import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import {
  countGroupInitiativesToday,
  readGroupInitiativeStatus,
  runGroupInitiativeTick,
} from "../server/utils/group-initiative";
import { groupChatDayStart } from "../server/utils/channel-adapter/onebot/group-chat";

/**
 * 群内找话题的数据库侧测试：活跃度表的唯一约束、按群的当日计数、tick 的配置性早退。
 *
 * 和 `test-proactive-db` 一样**不测「真发一条」**：那要能连上的 OneBot，
 * 一旦红在「本机没开 QQ」上，两次之后大家就开始忽略这个测试了。
 */

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("缺少 DATABASE_URL，群内找话题数据库测试无法运行。");

const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });

async function main() {
  const ownerId = randomUUID();
  const characterId = randomUUID();
  const connectionId = randomUUID();
  const bindingId = randomUUID();
  const scopeId = randomUUID();
  const groupId = "700000001";
  const conversationKey = `g:${groupId}`;
  /** 这个群在按群覆盖里被设成「仅被 @ 时回复」：她不该在这里自己起话题。 */
  const mentionGroupId = "700000002";
  const mentionConversationKey = `g:${mentionGroupId}`;

  await prisma.user.create({
    data: { id: ownerId, username: `group-initiative-test-${randomUUID().slice(0, 8)}`, passwordHash: "test", role: "USER" },
  });

  try {
    await prisma.character.create({
      data: { id: characterId, ownerId, name: "group-initiative-test", basePrompt: "test persona" },
    });
    await prisma.memoryScope.create({
      data: { id: scopeId, characterId, scopeType: "CHARACTER_GLOBAL", scopeKey: `character:${characterId}:global` },
    });
    // 连接/绑定只为了让 `loadOnebotConnections` 能认出这条绑定；不填凭据就不会真连。
    await prisma.platformConnection.create({
      data: {
        id: connectionId,
        platform: "qq-onebot",
        displayName: "group-initiative-test",
        platformAccountKey: `test-${randomUUID().slice(0, 8)}`,
      },
    });
    await prisma.characterChannelBinding.create({
      data: {
        id: bindingId,
        characterId,
        connectionId,
        routingKey: `${groupId},${mentionGroupId}`,
        // 绑定级 ambient，但其中一个群单独设成「仅被 @ 时回复」—— 这正是会踩坑的形状：
        // 直读 binding.groupChat 的写法会把它当 ambient，然后在那个群里自己冒头。
        config: { groupChatMode: "ambient", groupChatModes: { [mentionGroupId]: "mention" } },
      },
    });

    // 1. 关着的时候直接 disabled，连活跃度都不查。
    const disabled = await runGroupInitiativeTick({ characterId });
    assert.equal(disabled.length, 1, "每个角色都应有一条结果，不能静默跳过");
    assert.equal(disabled[0]!.status, "skipped");
    assert.equal(disabled[0]!.reason, "disabled");

    // 2. 打开但一个群都没聊过 → no_group（不是「试着说一句再说」）。
    await prisma.character.update({
      where: { id: characterId },
      data: { modelConfig: { groupInitiative: { enabled: true, idleMinutes: 60, dailyMax: 3 } } },
    });
    assert.equal((await runGroupInitiativeTick({ characterId }))[0]!.reason, "no_group");

    // 3. force 也不跳过「有没有群」：那是配置性问题，不是时间性问题。
    assert.equal((await runGroupInitiativeTick({ characterId, force: true }))[0]!.reason, "no_group");

    // 4. 活跃度表的唯一键是「绑定 + 会话 key」：同一个群重复 upsert 只留一行。
    const upsert = (lastMessageAt: Date) => prisma.groupActivity.upsert({
      where: {
        channelBindingId_externalConversationId: {
          channelBindingId: bindingId,
          externalConversationId: conversationKey,
        },
      },
      create: {
        channelBindingId: bindingId,
        characterId,
        externalConversationId: conversationKey,
        groupId,
        lastMessageAt,
        recentLines: [{ speaker: "a", text: "hi", at: 1 }],
      },
      update: { lastMessageAt },
    });
    const first = new Date(Date.now() - 3 * 3_600_000);
    await upsert(first);
    const latest = new Date(Date.now() - 2 * 3_600_000);
    await upsert(latest);
    const rows = await prisma.groupActivity.findMany({ where: { channelBindingId: bindingId } });
    assert.equal(rows.length, 1, "同一个群只应有一行活跃度");
    assert.equal(rows[0]!.lastMessageAt.getTime(), latest.getTime());

    // 5. 按群的当日计数看消息元数据：只数 group-initiative，其余助手消息不算。
    const conversation = await prisma.conversation.create({
      data: {
        characterId,
        memoryScopeId: scopeId,
        channelBindingId: bindingId,
        externalConversationId: conversationKey,
        title: `QQ群 ${groupId}`,
        metadata: { platform: "qq-onebot", kind: "group", groupId },
      },
    });
    const now = new Date();
    await prisma.message.createMany({
      data: [
        {
          conversationId: conversation.id,
          role: "ASSISTANT",
          content: "这个群怎么没人说话",
          occurredAt: now,
          metadata: { source: "group-initiative" },
        },
        {
          conversationId: conversation.id,
          role: "ASSISTANT",
          content: "正常接话",
          occurredAt: now,
          metadata: { source: "channel" },
        },
        {
          // 昨天那条不算今天的额度（东八区日界）。
          conversationId: conversation.id,
          role: "ASSISTANT",
          content: "昨天开的头",
          occurredAt: new Date(groupChatDayStart().getTime() - 60_000),
          metadata: { source: "group-initiative" },
        },
      ],
    });
    assert.equal(
      await countGroupInitiativesToday(bindingId, conversationKey),
      1,
      "JSON 路径过滤 + 东八区日界：只数今天的、只数主动找话题那条",
    );

    // 6. 状态接口复用同一把闸门，并且能沿「连接 → 绑定 → 活跃度」找到这个群。
    //    **不调 runGroupInitiativeTick**：那一步会真去调模型（本机 .env 里可能有能用的 Key），
    //    测试不该有对外副作用。
    //    第二个群更冷（安静 5 小时），但它是「仅被 @」档 —— 应该被判 mention_only 并排在前面，
    //    这正是「按群覆盖」最容易被写错的地方。
    await prisma.groupActivity.create({
      data: {
        channelBindingId: bindingId,
        characterId,
        externalConversationId: mentionConversationKey,
        groupId: mentionGroupId,
        lastMessageAt: new Date(Date.now() - 5 * 3_600_000),
      },
    });

    const status = await readGroupInitiativeStatus(characterId, {
      groupInitiative: { enabled: true, idleMinutes: 60, dailyMax: 3 },
    });
    assert.equal(status.settings.dailyMax, 3);
    assert.equal(status.status.groups.length, 2, "两个群都该被认出来");
    // 按安静时长排序：最冷的是那个 mention 群。
    assert.equal(status.status.groups[0]!.groupId, mentionGroupId);
    assert.equal(status.status.groups[0]!.reason, "mention_only", "仅被 @ 的群不该由她起话题");
    assert.equal(status.status.groups[0]!.canSendNow, false);
    assert.equal(status.status.reason, "mention_only", "角色级结论取最冷那个群的原因");

    const ambient = status.status.groups.find((group) => group.groupId === groupId)!;
    assert.ok(ambient, "ambient 那个群要在列表里");
    assert.notEqual(ambient.reason, "mention_only", "绑定级 ambient + 按群覆盖没写着它，就该能开口");
    assert.ok(ambient.idleMinutes >= 100, "安静时长从活跃度表推出来");
    assert.equal(ambient.sentToday, 1, "今天只算那一条主动开口");

    console.log("✅ test-group-initiative-db 全部通过");
  } finally {
    // 清理：按外键顺序倒着删。
    const conversations = await prisma.conversation.findMany({
      where: { characterId },
      select: { id: true },
    }).catch(() => [] as Array<{ id: string }>);
    if (conversations.length) {
      await prisma.message.deleteMany({ where: { conversationId: { in: conversations.map((item) => item.id) } } }).catch(() => undefined);
      await prisma.conversation.deleteMany({ where: { id: { in: conversations.map((item) => item.id) } } }).catch(() => undefined);
    }
    await prisma.groupActivity.deleteMany({ where: { channelBindingId: bindingId } }).catch(() => undefined);
    await prisma.characterChannelBinding.deleteMany({ where: { id: bindingId } }).catch(() => undefined);
    await prisma.platformConnection.deleteMany({ where: { id: connectionId } }).catch(() => undefined);
    await prisma.memoryScope.deleteMany({ where: { characterId } }).catch(() => undefined);
    await prisma.character.deleteMany({ where: { id: characterId } }).catch(() => undefined);
    await prisma.user.delete({ where: { id: ownerId } }).catch(() => undefined);
    await prisma.$disconnect();
  }
}

void main();
