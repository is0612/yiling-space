import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getPrisma } from "../server/utils/prisma";
import { loadPreferencesForPrompt } from "../server/utils/preference-retrieval";
import { loadExpressionHabitsForPrompt } from "../server/utils/expression-habit-retrieval";
import { loadGoalsForPrompt } from "../server/utils/goal-retrieval";
import { readInteractionExperiences } from "../server/utils/interaction-experiences";
import { listAcquaintances } from "../server/utils/friends";

assert.match(new URL(process.env.DATABASE_URL ?? "").pathname, /^\/yiling_collaboration_test_[a-f0-9]{32}$/,
  "Use the disposable collaboration database wrapper.");
const db = getPrisma();
const query = "星灯观测";
try {
  const owner = await db.user.create({ data: { username: `consumer-${randomUUID()}`, passwordHash: "fixture" } });
  const character = await db.character.create({ data: { ownerId: owner.id, name: "合成消费者角色", basePrompt: "测试" } });
  const scope = await db.memoryScope.create({ data: { characterId: character.id, scopeType: "USER_PRIVATE", scopeKey: randomUUID(), userId: owner.id } });
  const room = await db.conversation.create({ data: { characterId: character.id, memoryScopeId: scope.id, title: "合成会话" } });
  const otherRoom = await db.conversation.create({ data: { characterId: character.id, memoryScopeId: scope.id, title: "另一个会话" } });
  const experience = await db.interactionExperience.create({ data: { characterId: character.id, conversationId: room.id, memoryScopeId: scope.id,
    assistantMessageId: randomUUID(), feedbackMessageId: randomUUID(), content: "星灯观测时先核对记录", context: query, feedbackQuote: "请先核对", evidenceHash: "a".repeat(64), status: "ACTIVE" } });
  await db.interactionExperience.create({ data: { characterId: character.id, conversationId: otherRoom.id, memoryScopeId: scope.id,
    assistantMessageId: randomUUID(), feedbackMessageId: randomUUID(), content: "OTHER_ROOM_SENTINEL", context: query, feedbackQuote: "合成", evidenceHash: "b".repeat(64), status: "ACTIVE" } });
  const preference = await db.characterPreference.create({ data: { characterId: character.id, kind: "LIKE", topic: query, reason: "已确认", status: "ACTIVE" } });
  const language = await db.characterExpressionHabit.create({ data: { characterId: character.id, kind: "TONE", content: "先给简洁结论", context: query, reason: "已确认", status: "ACTIVE", chatScope: "PRIVATE" } });
  const goal = await db.characterGoal.create({ data: { characterId: character.id, kind: "GOAL", title: query, description: "绘制观测图", reason: "已确认", status: "ACTIVE" } });
  await db.characterPreference.create({ data: { characterId: character.id, kind: "LIKE", topic: query, reason: "候选", status: "PENDING" } });
  await db.characterExpressionHabit.create({ data: { characterId: character.id, kind: "TONE", content: "未审核", context: query, reason: "候选", status: "PENDING" } });
  await db.characterGoal.create({ data: { characterId: character.id, kind: "GOAL", title: query, description: "未审核", reason: "候选", status: "PENDING" } });
  const identity = await db.externalIdentity.create({ data: { platform: "qq-onebot", platformUid: randomUUID(), displayName: "合成熟人" } });
  const relation = await db.memoryScope.create({ data: { characterId: character.id, scopeType: "EXTERNAL_IDENTITY", scopeKey: randomUUID(), externalIdentityId: identity.id,
    interactionCount: 3, firstSource: "PRIVATE", relationshipVersion: 0, relationshipStage: "CLOSE_FRIEND", relationshipStatus: "NORMAL" } });
  const read = async () => ({
    experience: await readInteractionExperiences(db, { characterId: character.id, conversationId: room.id, memoryScopeId: scope.id, query }),
    preference: await loadPreferencesForPrompt(db, character.id, query),
    language: await loadExpressionHabitsForPrompt(db, character.id, query, undefined, { conversationId: room.id, memoryScopeId: scope.id }, "PRIVATE"),
    goals: await loadGoalsForPrompt(db, character.id, query),
    social: await listAcquaintances({ characterId: character.id }),
  });
  const before = await read();
  assert.deepEqual(before.experience.map(r => r.id), [experience.id]);
  assert.deepEqual(before.preference.map(r => r.id), [preference.id]);
  assert.deepEqual(before.language.map(r => r.id), [language.id]);
  assert.deepEqual(before.goals.map(r => r.id), [goal.id]);
  assert.equal(before.social.fromPrivate[0]?.relationshipStage, undefined, "Unreviewed relationship values cannot become facts");
  assert.equal((await loadExpressionHabitsForPrompt(db, character.id, query, undefined, undefined, "GROUP")).length, 0);
  // Mutate the domain facts, then repeat the exact same consumer queries: no cross-turn stale cache.
  await db.interactionExperience.update({ where: { id: experience.id }, data: { status: "DISABLED" } });
  await db.characterPreference.update({ where: { id: preference.id }, data: { status: "DISABLED", revision: { increment: 1 } } });
  await db.characterExpressionHabit.update({ where: { id: language.id }, data: { status: "DISABLED", revision: { increment: 1 } } });
  await db.characterGoal.update({ where: { id: goal.id }, data: { status: "PAUSED", revision: { increment: 1 } } });
  await db.memoryScope.update({ where: { id: relation.id }, data: { relationshipVersion: 1, relationshipStage: "FRIEND", relationshipStatus: "REPAIRING" } });
  const after = await read();
  for (const key of ["experience", "preference", "language", "goals"] as const) assert.equal(after[key].length, 0, `${key} consumer must stop using inactive data`);
  assert.equal(after.social.fromPrivate[0]?.relationshipStage, "FRIEND");
  assert.equal(after.social.fromPrivate[0]?.relationshipStatus, "REPAIRING");
  await db.memoryScope.update({ where: { id: relation.id }, data: { friendChatPolicy: "BLOCK" } });
  assert.equal((await read()).social.fromPrivate.length, 0);
  console.log("Five real growth consumers passed: confirmed values, private scene/room isolation, pending exclusion, next-read lifecycle changes and reviewed social state/blocking.");
} finally { await db.$disconnect(); }
