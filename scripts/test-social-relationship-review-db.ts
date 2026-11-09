import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getPrisma } from "../server/utils/prisma";
import { ensureExternalIdentityScope } from "../server/utils/identity-scope";
import { reviewSocialRelationshipAssessment } from "../server/utils/social-relationship-review";

const databaseName = new URL(process.env.DATABASE_URL ?? "postgres://localhost/none").pathname.replace(/^\//, "");
assert(/^yiling_social_review_test_[a-f0-9]{32}$/.test(databaseName),
  `拒绝执行：当前库「${databaseName}」不是一次性社交关系人工确认测试库。`);

const prisma = getPrisma();
const runId = randomUUID().replaceAll("-", "").slice(0, 16);
const owner = await prisma.user.create({
  data: { username: `social-review-${runId}`, passwordHash: "x", role: "USER", status: "ACTIVE" },
  select: { id: true },
});
const character = await prisma.character.create({
  data: {
    ownerId: owner.id, name: "关系人工确认测试角色", basePrompt: "test",
    memoryScopes: { create: { scopeType: "CHARACTER_GLOBAL", scopeKey: `social-review-global:${runId}` } },
  },
  select: { id: true },
});
const globalScope = await prisma.memoryScope.findFirstOrThrow({
  where: { characterId: character.id, scopeType: "CHARACTER_GLOBAL" }, select: { id: true },
});
const identity = await prisma.externalIdentity.create({
  data: { platform: "qq-onebot", platformUid: `social-review-${runId}`, displayName: "人工确认测试好友", kind: "HUMAN" },
  select: { id: true },
});
const scopeId = (await ensureExternalIdentityScope(character.id, "qq-onebot", `social-review-${runId}`, identity.id)).scopeId;
const event = await prisma.memoryEvent.create({
  data: {
    memoryScopeId: globalScope.id, dayKey: "2026-11-09", occurredAt: new Date(),
    title: "明确互相支持的经历", detail: "双方在需要时提供了具体帮助。", dedupeKey: `review-event-${runId}`,
  },
  select: { id: true },
});
const experience = await prisma.socialExperience.create({
  data: { scopeId, memoryEventId: event.id, sourceKey: `review-source-${runId}` },
  select: { id: true },
});

async function makeAssessment(input: {
  expectedVersion: number;
  fromStage?: "STRANGER" | "ACQUAINTANCE";
  toStage: "ACQUAINTANCE" | "FRIEND";
  toStatus: "NORMAL" | "DISTANT" | "CONFLICT" | "REPAIRING";
}) {
  return prisma.socialRelationshipAssessment.create({
    data: {
      scopeId, generation: 1, triggerReasons: ["NEW_EXPERIENCE"],
      evaluatedStage: input.fromStage ?? "STRANGER",
      evaluatedStatus: "UNOBSERVED",
      relationshipVersion: input.expectedVersion,
      outcome: "CHANGE",
      suggestedStage: input.toStage,
      suggestedStatus: input.toStatus,
      reason: "测试关系建议：存在明确的互相支持经历。",
      observations: { newEvidenceExperienceIds: [experience.id] },
      status: "SUCCEEDED", reviewStatus: "PENDING", completedAt: new Date(),
      evidence: { create: [{ experienceId: experience.id, kind: "NEW" }] },
    },
    select: { id: true },
  });
}

const assessment = await makeAssessment({ expectedVersion: 0, toStage: "ACQUAINTANCE", toStatus: "NORMAL" });
try {
  console.log("\n[1] 暂缓只记录决定，不修改关系；之后允许继续处理");
  const deferred = await reviewSocialRelationshipAssessment(prisma, {
    characterId: character.id, assessmentId: assessment.id, actorUserId: owner.id,
    decision: "DEFERRED", note: "稍后再看。",
  });
  assert.equal(deferred.reviewStatus, "DEFERRED");
  let scope = await prisma.memoryScope.findUniqueOrThrow({ where: { id: scopeId } });
  assert.equal(scope.relationshipStage, "STRANGER");
  assert.equal(scope.relationshipStatus, "UNOBSERVED");
  assert.equal(scope.relationshipVersion, 0);

  console.log("\n[2] 采纳在单事务中更新阶段/状态、版本、变更历史和证据");
  const accepted = await reviewSocialRelationshipAssessment(prisma, {
    characterId: character.id, assessmentId: assessment.id, actorUserId: owner.id,
    decision: "ACCEPTED", note: "证据核对通过。",
  });
  assert.equal(accepted.applied, true);
  scope = await prisma.memoryScope.findUniqueOrThrow({ where: { id: scopeId } });
  assert.equal(scope.relationshipStage, "ACQUAINTANCE");
  assert.equal(scope.relationshipStatus, "NORMAL");
  assert.equal(scope.relationshipVersion, 1);
  const change = await prisma.socialRelationChange.findUniqueOrThrow({
    where: { assessmentId: assessment.id }, include: { evidence: true },
  });
  assert.equal(change.fromStage, "STRANGER");
  assert.equal(change.toStage, "ACQUAINTANCE");
  assert.equal(change.fromStatus, "UNOBSERVED");
  assert.equal(change.toStatus, "NORMAL");
  assert.equal(change.relationshipVersionBefore, 0);
  assert.equal(change.relationshipVersionAfter, 1);
  assert.equal(change.evidence.length, 1);
  assert.equal(change.evidence[0]?.experienceId, experience.id);
  assert.equal(await prisma.socialRelationshipAssessmentReview.count({ where: { assessmentId: assessment.id } }), 2);
  await assert.rejects(() => reviewSocialRelationshipAssessment(prisma, {
    characterId: character.id, assessmentId: assessment.id, actorUserId: owner.id,
    decision: "ACCEPTED", note: null,
  }), /已经处理/);

  console.log("\n[3] 关系版本过期时标记 STALE，绝不覆盖当前关系");
  const staleAssessment = await makeAssessment({
    expectedVersion: 0, fromStage: "STRANGER", toStage: "FRIEND", toStatus: "CONFLICT",
  });
  const stale = await reviewSocialRelationshipAssessment(prisma, {
    characterId: character.id, assessmentId: staleAssessment.id, actorUserId: owner.id,
    decision: "ACCEPTED", note: null,
  });
  assert.equal("stale" in stale && stale.stale, true);
  scope = await prisma.memoryScope.findUniqueOrThrow({ where: { id: scopeId } });
  assert.equal(scope.relationshipStage, "ACQUAINTANCE");
  assert.equal(scope.relationshipStatus, "NORMAL");
  assert.equal(scope.relationshipVersion, 1);
  const staleRow = await prisma.socialRelationshipAssessment.findUniqueOrThrow({ where: { id: staleAssessment.id } });
  assert.equal(staleRow.reviewStatus, "STALE");

  console.log("\n[4] 已被其他关系变更消费的 NEW 经历不能重复作为新证据");
  const duplicateEvidenceAssessment = await makeAssessment({
    expectedVersion: 1, fromStage: "ACQUAINTANCE", toStage: "FRIEND", toStatus: "DISTANT",
  });
  await assert.rejects(() => reviewSocialRelationshipAssessment(prisma, {
    characterId: character.id, assessmentId: duplicateEvidenceAssessment.id, actorUserId: owner.id,
    decision: "ACCEPTED", note: null,
  }), /已用于其他关系变化/);
  scope = await prisma.memoryScope.findUniqueOrThrow({ where: { id: scopeId } });
  assert.equal(scope.relationshipVersion, 1);
  const stillPending = await prisma.socialRelationshipAssessment.findUniqueOrThrow({ where: { id: duplicateEvidenceAssessment.id } });
  assert.equal(stillPending.reviewStatus, "PENDING");

  console.log("\n[5] 驳回保留审计记录，不修改关系");
  const rejectedAssessment = await makeAssessment({
    expectedVersion: 1, fromStage: "ACQUAINTANCE", toStage: "FRIEND", toStatus: "DISTANT",
  });
  const rejected = await reviewSocialRelationshipAssessment(prisma, {
    characterId: character.id, assessmentId: rejectedAssessment.id, actorUserId: owner.id,
    decision: "REJECTED", note: "不采纳。",
  });
  assert.equal(rejected.reviewStatus, "REJECTED");
  scope = await prisma.memoryScope.findUniqueOrThrow({ where: { id: scopeId } });
  assert.equal(scope.relationshipStage, "ACQUAINTANCE");
  assert.equal(scope.relationshipStatus, "NORMAL");
  assert.equal(scope.relationshipVersion, 1);

  console.log("社交关系人工确认数据库集成测试通过。");
} finally {
  await prisma.socialRelationshipAssessmentReview.deleteMany({ where: { assessment: { scopeId } } });
  await prisma.socialRelationChange.deleteMany({ where: { scopeId } });
  await prisma.socialRelationshipAssessment.deleteMany({ where: { scopeId } });
  await prisma.socialExperience.deleteMany({ where: { scopeId } });
  await prisma.memoryEvent.deleteMany({ where: { memoryScopeId: globalScope.id } });
  await prisma.memoryScope.deleteMany({ where: { characterId: character.id } });
  await prisma.externalIdentity.deleteMany({ where: { id: identity.id } });
  await prisma.character.deleteMany({ where: { id: character.id } });
  await prisma.user.deleteMany({ where: { id: owner.id } });
  await prisma.$disconnect();
}
