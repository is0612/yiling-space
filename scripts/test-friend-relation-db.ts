/**
 * 「她的朋友」记账回归：次数每次 +1，「最近一次」只往前推。
 *
 * 起因（2026-11-02 复核页面时）：`lastInteractedAt` 原来是无条件覆盖写，而写入用的是
 * 消息的**收到时刻**。乱序到达、补录旧消息、语音转写晚半小时，时间就会被往回拉 ——
 * 页面上看起来就是「明明刚聊过，最近一次还停在两小时前」。同一个群里的
 * `group_members.lastSpokeAt` 早就是「只往前推」，关系行这里漏了。
 *
 * 这个测试盯四件事：
 * 1. 正常一次：次数 +1，时间落在消息时刻；
 * 2. 乱序来一条更旧的：次数照加，时间不许倒退；
 * 3. 来一条更新的：时间推进；
 * 4. 传一个 Invalid Date：不许抛 —— 抛了调用方 `catch` 掉就是静默丢一次记账。
 *
 * 只用自己造的用户/角色/身份，finally 里清干净。
 */
import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getPrisma } from "../server/utils/prisma";
import { recordFriendInteraction } from "../server/utils/friends";

const prisma = getPrisma();
const suffix = randomUUID();
const userId = randomUUID();
const characterId = randomUUID();
const otherCharacterId = randomUUID();
const platformUid = `friend-relation-${suffix}`;
const PLATFORM = "test-platform";
const MINUTE = 60 * 1000;

async function readRelation() {
  const scope = await prisma.memoryScope.findUnique({
    where: { scopeKey: `character:${characterId}:external:${PLATFORM}:${platformUid}` },
    select: { id: true, externalIdentityId: true, interactionCount: true, lastInteractedAt: true, firstSource: true, friendChatPolicy: true },
  });
  assert.ok(scope, "关系行没建出来。");
  return scope;
}

function touch(at?: Date) {
  return recordFriendInteraction({
    characterId,
    platform: PLATFORM,
    platformUid,
    displayName: "回归测试朋友",
    source: "GROUP",
    at,
  });
}

try {
  await prisma.user.create({
    data: { id: userId, username: `friend-relation-${suffix}`, passwordHash: "integration-test-only" },
  });
  await prisma.character.createMany({
    data: [
      { id: characterId, ownerId: userId, name: "朋友记账回归", basePrompt: "integration test" },
      { id: otherCharacterId, ownerId: userId, name: "朋友关系隔离回归", basePrompt: "integration test" },
    ],
  });

  const mid = new Date(Date.now() - 3 * MINUTE * 60);

  // 1. 第一次：建行 + 计 1 次。
  await touch(mid);
  let relation = await readRelation();
  assert.equal(relation.interactionCount, 1, "第一次互动应该计 1 次。");
  assert.equal(relation.lastInteractedAt?.getTime(), mid.getTime(), "第一次互动的时间应当就是这条消息的时刻。");
  assert.equal(relation.firstSource, "GROUP", "第一次写来源。");

  // 2. 乱序来一条更旧的：次数照加，时间不许倒退（这就是那个 bug）。
  await touch(new Date(mid.getTime() - MINUTE * 60));
  relation = await readRelation();
  assert.equal(relation.interactionCount, 2, "旧消息也要计次 —— 她确实回过这个人。");
  assert.equal(
    relation.lastInteractedAt?.getTime(),
    mid.getTime(),
    "更旧的消息不许把「最近一次」拉回去。",
  );

  // 3. 更新的一条：时间往前推。
  const newer = new Date(mid.getTime() + MINUTE * 60);
  await touch(newer);
  relation = await readRelation();
  assert.equal(relation.interactionCount, 3, "第三次互动应该计 3 次。");
  assert.equal(relation.lastInteractedAt?.getTime(), newer.getTime(), "更新的消息要把时间推上去。");

  // 4. 坏日期：不许抛，退回「现在」。
  const beforeBadDate = relation.lastInteractedAt!.getTime();
  await touch(new Date("not a date"));
  relation = await readRelation();
  assert.equal(relation.interactionCount, 4, "坏日期也要计次，记账不能整轮丢掉。");
  assert.ok(
    (relation.lastInteractedAt?.getTime() ?? 0) > beforeBadDate,
    "坏日期应该退回「现在」，而不是写进一个 Invalid Date 或者把时间拉回去。",
  );

  // 5. 身份类型是平台账号全局属性，交流权限是角色关系属性。
  const identity = await prisma.externalIdentity.findUnique({
    where: { platform_platformUid: { platform: PLATFORM, platformUid } },
    select: { id: true, kind: true, kindSource: true },
  });
  assert.ok(identity, "平台身份必须存在。");
  assert.equal(identity.kind, "UNKNOWN", "新身份默认未知。");
  assert.equal(identity.kindSource, "AUTO", "未人工纠正前保留自动来源标记。");
  assert.equal(relation.friendChatPolicy, "DEFAULT", "新关系默认沿用自动交流策略。");

  await prisma.externalIdentity.update({
    where: { id: identity.id },
    data: { kind: "AI", kindSource: "MANUAL" },
  });
  await prisma.memoryScope.update({
    where: { id: relation.id },
    data: { friendChatPolicy: "BLOCK" },
  });

  await recordFriendInteraction({
    characterId: otherCharacterId,
    platform: PLATFORM,
    platformUid,
    displayName: "另一个角色也认识的朋友",
    source: "GROUP",
  });
  const otherScope = await prisma.memoryScope.findUnique({
    where: { scopeKey: `character:${otherCharacterId}:external:${PLATFORM}:${platformUid}` },
    select: { id: true, externalIdentityId: true, friendChatPolicy: true },
  });
  assert.ok(otherScope, "另一个角色应该有独立关系。");
  assert.equal(otherScope.externalIdentityId, identity.id, "两个角色共享同一个平台身份。");
  assert.equal(otherScope.friendChatPolicy, "DEFAULT", "另一个角色的默认交流策略不能被第一个角色的 BLOCK 污染。");

  await prisma.memoryScope.update({ where: { id: relation.id }, data: { friendChatPolicy: "ALLOW" } });
  const [updatedIdentity, isolatedScope] = await Promise.all([
    prisma.externalIdentity.findUnique({ where: { id: identity.id }, select: { kind: true, kindSource: true } }),
    prisma.memoryScope.findUnique({ where: { id: otherScope.id }, select: { friendChatPolicy: true } }),
  ]);
  assert.deepEqual(updatedIdentity, { kind: "AI", kindSource: "MANUAL" }, "人工身份纠正不会因角色关系更新而丢失。");
  assert.equal(isolatedScope?.friendChatPolicy, "DEFAULT", "第一个角色的 ALLOW 也不能串到第二个角色。");

  console.log("通过：互动次数与时间、防乱序、异常日期兜底，以及平台身份全局共享、交流策略按角色隔离。");
} finally {
  await prisma.memoryScope.deleteMany({ where: { characterId: { in: [characterId, otherCharacterId] } } });
  await prisma.externalIdentity.deleteMany({ where: { platform: PLATFORM, platformUid } });
  await prisma.character.deleteMany({ where: { id: { in: [characterId, otherCharacterId] } } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
}
