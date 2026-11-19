import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getPrisma } from "../server/utils/prisma";
import { loadSelfUnderstanding } from "../server/utils/self-understanding-reader";
import { experienceReflectionHash } from "../server/utils/experience-reflection";
assert.match(new URL(process.env.DATABASE_URL ?? "").pathname, /^\/yiling_collaboration_test_[a-f0-9]{32}$/);
const db = getPrisma();
try {
  const owner = await db.user.create({ data: { username: `self-${randomUUID()}`, passwordHash: "fixture" } });
  const character = await db.character.create({ data: { ownerId: owner.id, name: "当前名字", avatar: "鲸鱼外观", basePrompt: "HIDDEN_FOUNDATION_SENTINEL" } });
  const foreign = await db.character.create({ data: { ownerId: owner.id, name: "另一角色", basePrompt: "test" } });
  const global = await db.memoryScope.create({ data: { characterId: character.id, scopeType: "CHARACTER_GLOBAL", scopeKey: randomUUID() } });
  const own = await db.memoryScope.create({ data: { characterId: character.id, scopeType: "USER_PRIVATE", scopeKey: randomUUID(), userId: owner.id } });
  const otherUser = await db.user.create({ data: { username: `other-self-${randomUUID()}`, passwordHash: "fixture" } });
  const other = await db.memoryScope.create({ data: { characterId: character.id, scopeType: "USER_PRIVATE", scopeKey: randomUUID(), userId: otherUser.id } });
  const foreignScope = await db.memoryScope.create({ data: { characterId: foreign.id, scopeType: "CHARACTER_GLOBAL", scopeKey: randomUUID() } });
  const room = await db.conversation.create({ data: { characterId: character.id, memoryScopeId: own.id } });
  const anotherRoom = await db.conversation.create({ data: { characterId: character.id, memoryScopeId: own.id } });
  await db.memoryItem.createMany({ data: [
    { memoryScopeId: global.id, category: "FACT", content: "公开学习记录" },
    { memoryScopeId: own.id, category: "FACT", content: "OWN_PRIVATE_SENTINEL" },
    { memoryScopeId: other.id, category: "FACT", content: "OTHER_PERSON_SENTINEL" },
    { memoryScopeId: foreignScope.id, category: "FACT", content: "FOREIGN_ROLE_SENTINEL" },
  ] });
  const pref = await db.characterPreference.create({ data: { characterId: character.id, kind: "LIKE", topic: "园艺", reason: "人工确认", status: "ACTIVE", revision: 3 } });
  await db.characterPreferenceRevision.createMany({ data: [
    { preferenceId: pref.id, actorId: owner.id, revision: 1, action: "CREATE", kind: "INTEREST", topic: "种花", status: "ACTIVE", sourceType: "MANUAL", sourceRefs: [], reason: "AUDIT_REASON_SENTINEL" },
    { preferenceId: pref.id, actorId: owner.id, revision: 2, action: "EDIT", kind: "DISLIKE", topic: "UNAPPROVED_HISTORY_SENTINEL", status: "PENDING", sourceType: "MANUAL", sourceRefs: [], reason: "草稿" },
    { preferenceId: pref.id, actorId: owner.id, revision: 3, action: "EDIT", kind: "LIKE", topic: "园艺", status: "ACTIVE", sourceType: "MANUAL", sourceRefs: [], reason: "人工确认" },
  ] });
  const habit = await db.characterExpressionHabit.create({ data: { characterId: character.id, kind: "WORDING", content: "简明说明依据", context: "", reason: "人工确认", status: "ACTIVE", chatScope: "ALL", revision: 3 } });
  await db.characterExpressionHabitRevision.createMany({ data: [
    { habitId: habit.id, actorId: owner.id, revision: 1, action: "CREATE", kind: "WORDING", content: "PRIVATE_HABIT_HISTORY_SENTINEL", context: "", reason: "旧私人场景", status: "ACTIVE", chatScope: "PRIVATE", sourceType: "MANUAL", sourceRefs: [] },
    { habitId: habit.id, actorId: owner.id, revision: 2, action: "EDIT", kind: "WORDING", content: "先举例再说明", context: "", reason: "人工确认", status: "ACTIVE", chatScope: "ALL", sourceType: "MANUAL", sourceRefs: [] },
    { habitId: habit.id, actorId: owner.id, revision: 3, action: "EDIT", kind: "WORDING", content: "简明说明依据", context: "", reason: "人工确认", status: "ACTIVE", chatScope: "ALL", sourceType: "MANUAL", sourceRefs: [] },
  ] });
  const friend = await db.externalIdentity.create({ data: { platform: "qq-onebot", platformUid: `test-${randomUUID()}`, displayName: "OWNER_RELATION_SENTINEL" } });
  const social = await db.memoryScope.create({ data: { characterId: character.id, scopeType: "EXTERNAL_IDENTITY", scopeKey: randomUUID(), externalIdentityId: friend.id, interactionCount: 2, relationshipVersion: 2, relationshipStage: "FRIEND", relationshipStatus: "NORMAL", firstSource: "PRIVATE" } });
  const assessment = await db.socialRelationshipAssessment.create({ data: { scopeId: social.id, generation: 1, relationshipVersion: 1,
    evaluatedStage: "ACQUAINTANCE", evaluatedStatus: "NORMAL", suggestedStage: "FRIEND", suggestedStatus: "NORMAL", status: "SUCCEEDED", reviewStatus: "ACCEPTED", outcome: "CHANGE" } });
  await db.socialRelationChange.create({ data: { scopeId: social.id, assessmentId: assessment.id, relationshipVersionBefore: 1, relationshipVersionAfter: 2,
    fromStage: "ACQUAINTANCE", toStage: "FRIEND", fromStatus: "NORMAL", toStatus: "NORMAL", reason: "PRIVATE_ASSESSMENT_REASON_SENTINEL", idempotencyKey: randomUUID() } });
  const goal = await db.characterGoal.create({ data: { characterId: character.id, kind: "GOAL", title: "完成花园", description: "先照料幼苗", reason: "合成目标", status: "ACTIVE", revision: 2 } });
  await db.characterGoalRevision.createMany({ data: [
    { goalId: goal.id, actorId: owner.id, revision: 1, action: "CREATE", kind: "GOAL", title: "完成花园", description: "先画草图", status: "ACTIVE", reason: "合成目标", sourceType: "MANUAL", sourceRefs: [] },
    { goalId: goal.id, actorId: owner.id, revision: 2, action: "EDIT", kind: "GOAL", title: "完成花园", description: "先照料幼苗", status: "ACTIVE", reason: "合成目标", sourceType: "MANUAL", sourceRefs: [] },
  ] });
  for (const day of [1, 4, 5, 6, 7, 8]) await db.memoryEvent.create({ data: { memoryScopeId: global.id,
    dayKey: `2026-10-0${day}`, occurredAt: new Date(`2026-10-0${day}T02:00:00Z`), dedupeKey: `self-episode-${day}`,
    title: `Episode ${day}`, detail: "合成样本", createdAt: new Date("2026-11-01T02:00:00Z") } });
  await db.characterPreference.create({ data: { characterId: character.id, kind: "LIKE", topic: "PENDING_SENTINEL", reason: "候选", status: "PENDING" } });
  const knowledge = await db.knowledgeItem.create({ data: { characterId: character.id, title: "育苗", content: "幼苗需要光照", category: "GENERAL", sourceType: "MANUAL", confidence: 0.2 } });
  const experience = await db.interactionExperience.create({ data: { characterId: character.id, conversationId: room.id, memoryScopeId: own.id,
    assistantMessageId: randomUUID(), feedbackMessageId: randomUUID(), content: "OLD_FAILURE_SENTINEL：旧回复曾声称永远读不到", context: "方案讨论", feedbackQuote: "先核对", evidenceHash: "a".repeat(64), status: "ACTIVE",
    learning: { kind: "UNDERSTANDING", situation: "旧查询曾失败", misunderstanding: "把一次失败当成永久限制", correction: "应核对当前证据", nextJudgment: "先检查当前权限及实际查询结果" } } });
  const refs = [{ key: `experience:${experience.id}`, type: "experience", id: experience.id, hash: experienceReflectionHash(experience), conversationId: room.id, memoryScopeId: own.id }];
  const createReflection = async (conversationId: string | null, memoryScopeId: string | null) => {
    const run = await db.reflectionRun.create({ data: { characterId: character.id, requestKey: randomUUID(), periodStart: new Date(0), periodEnd: new Date(), conversationId, memoryScopeId } });
    return db.reflectionSuggestion.create({ data: { runId: run.id, title: "合成观察", observation: "另一个伙伴曾在旧测试中查询失败。".repeat(20), inference: "这只是过去场景，不能推断当前无法查询", recommendation: "核对当前权限和实际结果后再作判断", status: "ACCEPTED", sourceRefs: refs } });
  };
  const reflection = await createReflection(room.id, own.id);
  const invalidGlobal = await createReflection(null, null);
  const args = { characterId: character.id, readableScopeIds: [global.id, own.id, foreignScope.id], conversationId: room.id, groupChat: false };
  const view = await loadSelfUnderstanding(db, args);
  const serialized = JSON.stringify(view);
  assert.equal(view.identity.name, "当前名字");
  assert.equal(view.runtimeEvidence.memoryRead, "authorized_scoped_read_succeeded");
  assert.equal(view.runtimeEvidence.historyCompleteness, "not_established");
  assert.equal(view.presentation.meaning, "appearance_only");
  assert.equal(view.evidence.find(row => row.id === knowledge.id)?.confidence, 0.2);
  assert.equal(view.evidence.find(row => row.id === knowledge.id)?.status, "active_record");
  assert(serialized.includes("OWN_PRIVATE_SENTINEL"));
  for (const sentinel of ["OTHER_PERSON_SENTINEL", "FOREIGN_ROLE_SENTINEL", "PENDING_SENTINEL", "HIDDEN_FOUNDATION_SENTINEL"]) assert(!serialized.includes(sentinel));
  assert(view.evidence.some(row => row.id === reflection.id && row.status === "accepted_interpretation"));
  const reflectionEvidence = view.evidence.find(row => row.id === reflection.id)!;
  assert(reflectionEvidence.excerpt.includes("暂时推断:"));
  assert(reflectionEvidence.excerpt.includes("建议:"));
  assert.equal(reflectionEvidence.excerptTruncated, true);
  const experienceEvidence = view.evidence.find(row => row.id === experience.id)!;
  assert(experienceEvidence.excerpt.includes("用户纠正: 应核对当前证据"));
  assert(experienceEvidence.excerpt.includes("下次判断: 先检查当前权限"));
  assert.equal(experienceEvidence.subject, "current_character_response");
  assert(!experienceEvidence.excerpt.includes("OLD_FAILURE_SENTINEL"));
  assert(!view.evidence.some(row => row.id === invalidGlobal.id), "Global reflection cannot borrow private references");
  assert.equal(view.history, undefined, "Current-only requests do not fetch old revisions");
  const retrospective = await loadSelfUnderstanding(db, { ...args, profileOwner: true, includeHistory: true });
  assert.deepEqual(retrospective.history?.map(row => [row.id, row.previous.revision, row.current.revision]), [[pref.id, 1, 3], [habit.id, 2, 3], [goal.id, 1, 2], [social.id, 1, 2]]);
  const relationshipHistory = retrospective.history?.find(row => row.id === social.id);
  assert.equal(relationshipHistory?.previous.excerpt, "ACQUAINTANCE, NORMAL");
  assert.equal(relationshipHistory?.previous.recordedAt, undefined, "An accepted transition does not date the previous state");
  assert.equal(relationshipHistory?.current.excerpt, "FRIEND, NORMAL");
  assert(!JSON.stringify(retrospective).includes("PRIVATE_ASSESSMENT_REASON_SENTINEL"));
  assert.equal(retrospective.history?.[0]?.previous.excerpt, "INTEREST: 种花");
  const episode = retrospective.evidence.find(row => row.excerpt.startsWith("Episode 1:"));
  assert.equal(episode?.occurredAt, "2026-10-01T02:00:00.000Z");
  assert.equal(episode.updatedAt, "2026-11-01T02:00:00.000Z");
  assert(episode.context?.includes("未保留原文"));
  assert(retrospective.evidence.some(row => row.domain === "social" && row.excerpt.includes("OWNER_RELATION_SENTINEL")));
  const historyText = JSON.stringify(retrospective);
  for (const sentinel of ["AUDIT_REASON_SENTINEL", "UNAPPROVED_HISTORY_SENTINEL", "PRIVATE_HABIT_HISTORY_SENTINEL"]) assert(!historyText.includes(sentinel));
  assert(!serialized.includes("OWNER_RELATION_SENTINEL"), "Other contacts do not get the private relationship roster");
  const group = await loadSelfUnderstanding(db, { ...args, profileOwner: true, includeHistory: true, readableScopeIds: [global.id, own.id, other.id], groupChat: true });
  assert(!JSON.stringify(group).includes("OWNER_RELATION_SENTINEL"));
  assert(!JSON.stringify(group).includes("PRIVATE_HABIT_HISTORY_SENTINEL"));
  assert(!group.evidence.some(row => row.occurredAt), "A group with no authorized event in its room must not inherit old events");
  assert(group.evidence.every(row => row.scope === "character"));
  assert(!JSON.stringify(group).includes("OWN_PRIVATE_SENTINEL"));
  assert(!group.evidence.some(row => row.domain === "experience" || row.domain === "reflection"));
  const alternate = await loadSelfUnderstanding(db, { ...args, conversationId: anotherRoom.id });
  assert(!alternate.evidence.some(row => row.id === experience.id || row.id === reflection.id));
  await db.characterPreference.update({ where: { id: pref.id }, data: { status: "DISABLED", revision: { increment: 1 } } });
  await db.knowledgeItem.update({ where: { id: knowledge.id }, data: { status: "ARCHIVED", revision: { increment: 1 } } });
  await db.interactionExperience.update({ where: { id: experience.id }, data: { status: "DISABLED" } });
  await db.character.update({ where: { id: character.id }, data: { name: "修订后的名字" } });
  const refreshed = await loadSelfUnderstanding(db, args);
  assert.equal(refreshed.identity.name, "修订后的名字");
  assert(!refreshed.evidence.some(row => [pref.id, knowledge.id, experience.id, reflection.id].includes(row.id)));
  console.log("Self-understanding DB view passed: actor-provided scopes, role isolation, public/private/room boundaries, pending exclusion, private-reflection rejection, presentation separation and next-read lifecycle changes.");
} finally { await db.$disconnect(); }
