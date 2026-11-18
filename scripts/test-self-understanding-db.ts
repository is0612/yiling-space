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
  const pref = await db.characterPreference.create({ data: { characterId: character.id, kind: "LIKE", topic: "园艺", reason: "人工确认", status: "ACTIVE" } });
  await db.characterPreference.create({ data: { characterId: character.id, kind: "LIKE", topic: "PENDING_SENTINEL", reason: "候选", status: "PENDING" } });
  const knowledge = await db.knowledgeItem.create({ data: { characterId: character.id, title: "育苗", content: "幼苗需要光照", category: "GENERAL", sourceType: "MANUAL", confidence: 0.2 } });
  const experience = await db.interactionExperience.create({ data: { characterId: character.id, conversationId: room.id, memoryScopeId: own.id,
    assistantMessageId: randomUUID(), feedbackMessageId: randomUUID(), content: "讨论方案先核对", context: "方案讨论", feedbackQuote: "先核对", evidenceHash: "a".repeat(64), status: "ACTIVE" } });
  const refs = [{ key: `experience:${experience.id}`, type: "experience", id: experience.id, hash: experienceReflectionHash(experience), conversationId: room.id, memoryScopeId: own.id }];
  const createReflection = async (conversationId: string | null, memoryScopeId: string | null) => {
    const run = await db.reflectionRun.create({ data: { characterId: character.id, requestKey: randomUUID(), periodStart: new Date(0), periodEnd: new Date(), conversationId, memoryScopeId } });
    return db.reflectionSuggestion.create({ data: { runId: run.id, title: "合成观察", observation: "原会话的纠正", inference: "可能倾向先核对", recommendation: "核对后回应", status: "ACCEPTED", sourceRefs: refs } });
  };
  const reflection = await createReflection(room.id, own.id);
  const invalidGlobal = await createReflection(null, null);
  const args = { characterId: character.id, readableScopeIds: [global.id, own.id, foreignScope.id], conversationId: room.id, groupChat: false };
  const view = await loadSelfUnderstanding(db, args);
  const serialized = JSON.stringify(view);
  assert.equal(view.identity.name, "当前名字");
  assert.equal(view.presentation.meaning, "appearance_only");
  assert.equal(view.evidence.find(row => row.id === knowledge.id)?.confidence, 0.2);
  assert.equal(view.evidence.find(row => row.id === knowledge.id)?.status, "active_record");
  assert(serialized.includes("OWN_PRIVATE_SENTINEL"));
  for (const sentinel of ["OTHER_PERSON_SENTINEL", "FOREIGN_ROLE_SENTINEL", "PENDING_SENTINEL", "HIDDEN_FOUNDATION_SENTINEL"]) assert(!serialized.includes(sentinel));
  assert(view.evidence.some(row => row.id === reflection.id && row.status === "accepted_interpretation"));
  assert(!view.evidence.some(row => row.id === invalidGlobal.id), "Global reflection cannot borrow private references");
  const group = await loadSelfUnderstanding(db, { ...args, readableScopeIds: [global.id, own.id, other.id], groupChat: true });
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
