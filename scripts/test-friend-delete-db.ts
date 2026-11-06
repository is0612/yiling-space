/**
 * 删朋友回归：一条关系被删掉时，该走的都走了，不该动的都没动。
 *
 * 这个操作是破坏性的，且顺序很容易错（Conversation 是 Restrict，不是 Cascade），
 * 所以盯这几条：
 * 1. 关系行没了，它名下的会话 / 消息 / 记忆 / 阶段总结 / 忆泡 / 待审备注一起没了；
 * 2. 平台身份（ExternalIdentity）留着 —— 同一个号可能是另一个角色的朋友，那边的行必须还在；
 * 3. 删之前先把 chat_requests 里指向这段会话的行 tombstone 掉，删完不能用旧 requestKey 重放；
 * 4. 留一条 FRIEND_DELETED 审计，数字对得上；
 * 5. 重复删同一 id 返回 null（调用方翻译成 404），不抛。
 *
 * 只用自己造的数据，finally 里清干净。
 */
import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getPrisma } from "../server/utils/prisma";
import { deleteFriendScope } from "../server/utils/friend-delete";
import { DELETED_DESKTOP_CONVERSATION_REQUEST_ERROR } from "../server/utils/desktop-conversation";
import { buildExternalIdentityScopeKey } from "../server/utils/identity-scope";

const prisma = getPrisma();
const suffix = randomUUID();
const PLATFORM = "test-platform";

const userId = randomUUID();
const characterId = randomUUID();
const otherCharacterId = randomUUID();
const identityId = randomUUID();
const platformUid = `friend-delete-${suffix}`;
const scopeId = randomUUID();
const otherScopeId = randomUUID();
const conversationId = randomUUID();
const requestId = randomUUID();

const scopeKey = buildExternalIdentityScopeKey(characterId, PLATFORM, platformUid);
const otherScopeKey = buildExternalIdentityScopeKey(otherCharacterId, PLATFORM, platformUid);

try {
  await prisma.user.create({
    data: { id: userId, username: `friend-delete-${suffix}`, passwordHash: "integration-test-only" },
  });
  await prisma.character.createMany({
    data: [
      { id: characterId, ownerId: userId, name: "删朋友回归", basePrompt: "integration test" },
      { id: otherCharacterId, ownerId: userId, name: "另一个角色", basePrompt: "integration test" },
    ],
  });
  await prisma.externalIdentity.create({
    data: { id: identityId, platform: PLATFORM, platformUid, displayName: "要被删掉的朋友" },
  });

  // 两条关系共用同一个平台身份：删掉一条，另一条必须原样在。
  await prisma.memoryScope.createMany({
    data: [
      {
        id: scopeId,
        characterId,
        scopeType: "EXTERNAL_IDENTITY",
        scopeKey,
        externalIdentityId: identityId,
        interactionCount: 3,
        firstSource: "PRIVATE",
        friendChatPolicy: "ALLOW",
        aliases: ["小鱼干"],
      },
      {
        id: otherScopeId,
        characterId: otherCharacterId,
        scopeType: "EXTERNAL_IDENTITY",
        scopeKey: otherScopeKey,
        externalIdentityId: identityId,
        interactionCount: 7,
        firstSource: "GROUP",
      },
    ],
  });

  await prisma.conversation.create({
    data: { id: conversationId, characterId, memoryScopeId: scopeId, title: "私聊" },
  });
  await prisma.message.createMany({
    data: [
      { conversationId, role: "USER", content: "在吗", occurredAt: new Date("2026-11-01T10:00:00Z"), externalMessageId: "m1" },
      { conversationId, role: "ASSISTANT", content: "在的", occurredAt: new Date("2026-11-01T10:00:05Z"), externalMessageId: "m2" },
    ],
  });
  // 幂等行：删完应该变成 FAILED + 固定 lastError，而不是消失。
  await prisma.chatRequest.create({
    data: {
      id: requestId,
      ownerId: userId,
      characterId,
      requestKey: randomUUID(),
      claimToken: randomUUID(),
      status: "SUCCEEDED",
      conversationId,
      response: { reply: "在的" },
    },
  });

  await prisma.memoryItem.create({
    data: { memoryScopeId: scopeId, category: "FACT", content: "对方养了一只叫豆豆的猫" },
  });
  await prisma.memorySnapshot.create({
    data: {
      snapshotKey: `friend-delete-${suffix}`,
      memoryScopeId: scopeId,
      periodStart: new Date("2026-10-01T00:00:00Z"),
      periodEnd: new Date("2026-10-31T00:00:00Z"),
      summary: "这个月聊过几次",
      structuredContent: { facts: [] },
    },
  });
  await prisma.memoryEvent.create({
    data: {
      memoryScopeId: scopeId,
      dayKey: "2026-11-01",
      occurredAt: new Date("2026-11-01T10:00:00Z"),
      title: "在私聊里打了个招呼",
      detail: "对方先开口。",
      dedupeKey: `friend-delete-${suffix}`,
    },
  });
  await prisma.friendAliasSuggestion.create({
    data: { scopeId, alias: "豆豆铲屎官", aliasKey: "豆豆铲屎官", reason: "他老提那只猫" },
  });

  const outcome = await deleteFriendScope({ scopeId, actorId: userId });

  assert.ok(outcome, "第一次删应该成功。");
  assert.equal(outcome.characterId, characterId);
  assert.equal(outcome.platformUid, platformUid);
  assert.deepEqual(outcome.deleted, {
    conversations: 1,
    messages: 2,
    memoryItems: 1,
    snapshots: 1,
    events: 1,
    suggestions: 1,
  });

  // 1. 关系名下的东西全没了
  assert.equal(await prisma.memoryScope.count({ where: { id: scopeId } }), 0, "关系行应该被删掉。");
  assert.equal(await prisma.conversation.count({ where: { id: conversationId } }), 0, "会话应该被删掉。");
  assert.equal(await prisma.message.count({ where: { conversationId } }), 0, "消息应该跟着会话走。");
  assert.equal(await prisma.memoryItem.count({ where: { memoryScopeId: scopeId } }), 0, "长期记忆应该被删掉。");
  assert.equal(await prisma.memorySnapshot.count({ where: { memoryScopeId: scopeId } }), 0, "阶段总结应该被删掉。");
  assert.equal(await prisma.memoryEvent.count({ where: { memoryScopeId: scopeId } }), 0, "忆泡应该被删掉。");
  assert.equal(await prisma.friendAliasSuggestion.count({ where: { scopeId } }), 0, "待审备注应该被删掉。");

  // 2. 平台身份和另一个角色的关系不动
  assert.equal(await prisma.externalIdentity.count({ where: { id: identityId } }), 1, "平台身份必须留着。");
  assert.equal(await prisma.memoryScope.count({ where: { id: otherScopeId } }), 1, "另一个角色的关系不该被连带删掉。");

  // 3. 幂等行被 tombstone，而不是直接没了
  const tombstoned = await prisma.chatRequest.findUnique({
    where: { id: requestId },
    select: { status: true, lastError: true, response: true },
  });
  assert.equal(tombstoned?.status, "FAILED", "指向已删会话的请求要标成 FAILED。");
  assert.equal(tombstoned?.lastError, DELETED_DESKTOP_CONVERSATION_REQUEST_ERROR);
  assert.equal(tombstoned?.response, null, "缓存的回复要清掉，否则删完还能拿到旧答案。");

  // 4. 审计留痕
  const audit = await prisma.auditLog.findFirst({
    where: { action: "FRIEND_DELETED", entityId: scopeId },
    select: { actorId: true, characterId: true, details: true },
  });
  assert.ok(audit, "应该留一条 FRIEND_DELETED 审计。");
  assert.equal(audit.actorId, userId);
  assert.equal(audit.characterId, characterId);
  const details = audit.details as Record<string, unknown> | null;
  assert.equal(details?.platformUid, platformUid);
  assert.equal(details?.conversations, 1);
  assert.equal(details?.interactionCount, 3);

  // 5. 再删一次：返回 null，不抛
  assert.equal(await deleteFriendScope({ scopeId, actorId: userId }), null, "重复删除应该安静地返回 null。");

  console.log("test:friend-delete-db —— 全部通过。");
} finally {
  await prisma.auditLog.deleteMany({ where: { entityId: scopeId } });
  await prisma.chatRequest.deleteMany({ where: { ownerId: userId } });
  await prisma.memoryScope.deleteMany({ where: { characterId: { in: [characterId, otherCharacterId] } } });
  await prisma.character.deleteMany({ where: { id: { in: [characterId, otherCharacterId] } } });
  await prisma.externalIdentity.deleteMany({ where: { id: identityId } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
}
