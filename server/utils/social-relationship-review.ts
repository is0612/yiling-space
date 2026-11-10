import { createError } from "h3";
import type { PrismaClient } from "../../src/generated/prisma/client";
import { validateSocialAssessmentSourceManifest } from "./social-assessment-evidence";

export type SocialRelationshipReviewDecision = "ACCEPTED" | "REJECTED" | "DEFERRED";

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string"))];
}

export async function reviewSocialRelationshipAssessment(
  prisma: PrismaClient,
  input: {
    characterId: string;
    assessmentId: string;
    actorUserId: string;
    decision: SocialRelationshipReviewDecision;
    note: string | null;
  },
) {
  const { characterId, assessmentId, actorUserId, decision, note } = input;
  return prisma.$transaction(async tx => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT a."id"
      FROM "social_relationship_assessments" a
      INNER JOIN "memory_scopes" s ON s."id" = a."scopeId"
      WHERE a."id" = ${assessmentId}::uuid
        AND s."characterId" = ${characterId}::uuid
        AND s."scopeType" = 'EXTERNAL_IDENTITY'::"MemoryScopeType"
      FOR UPDATE OF a
    `;
    if (!locked.length) throw createError({ statusCode: 404, statusMessage: "关系评估记录不存在。" });

    const assessment = await tx.socialRelationshipAssessment.findUniqueOrThrow({
      where: { id: assessmentId },
      include: {
        scope: {
          select: { id: true, relationshipStage: true, relationshipStatus: true, relationshipVersion: true },
        },
        evidence: { where: { kind: "NEW" }, select: { experienceId: true } },
      },
    });
    if (assessment.status !== "SUCCEEDED" || assessment.outcome !== "CHANGE") {
      throw createError({ statusCode: 409, statusMessage: "这条评估不是可采纳的有效关系变化建议。" });
    }
    if (assessment.reviewStatus !== "PENDING" && assessment.reviewStatus !== "DEFERRED") {
      throw createError({ statusCode: 409, statusMessage: "这条建议已经处理，不能重复处置。" });
    }

    const now = new Date();
    if (decision !== "ACCEPTED") {
      const reviewStatus = decision === "DEFERRED" ? "DEFERRED" : "REJECTED";
      await tx.socialRelationshipAssessmentReview.create({
        data: { assessmentId, reviewerUserId: actorUserId, decision, note },
      });
      await tx.socialRelationshipAssessment.update({
        where: { id: assessmentId },
        data: { reviewStatus, reviewedAt: now, reviewedByUserId: actorUserId },
      });
      return { decision, reviewStatus, applied: false };
    }

    const scope = assessment.scope;
    const fromStage = scope.relationshipStage ?? "STRANGER";
    const fromStatus = scope.relationshipStatus ?? "UNOBSERVED";
    if (
      scope.relationshipVersion !== assessment.relationshipVersion ||
      fromStage !== assessment.evaluatedStage ||
      fromStatus !== assessment.evaluatedStatus
    ) {
      await tx.socialRelationshipAssessmentReview.create({
        data: {
          assessmentId, reviewerUserId: actorUserId, decision: "STALE",
          note: "关系阶段、相处状态或版本已变化，旧建议不能应用。",
        },
      });
      await tx.socialRelationshipAssessment.update({
        where: { id: assessmentId },
        data: { reviewStatus: "STALE", reviewedAt: now, reviewedByUserId: actorUserId },
      });
      return { decision, reviewStatus: "STALE", applied: false, stale: true };
    }

    const toStage = assessment.suggestedStage;
    const toStatus = assessment.suggestedStatus;
    if (!toStage || !toStatus || (toStage === fromStage && toStatus === fromStatus)) {
      throw createError({ statusCode: 409, statusMessage: "评估建议缺少有效变化目标，请重新评估。" });
    }

    const observationData = assessment.observations !== null && typeof assessment.observations === "object" && !Array.isArray(assessment.observations)
      ? assessment.observations as Record<string, unknown>
      : {};
    const suggestedNewIds = new Set(asStringList(observationData.newEvidenceExperienceIds));
    const candidateIds = assessment.evidence.map(item => item.experienceId).filter(id => suggestedNewIds.has(id));
    const citedIds = [...new Set([...asStringList(observationData.evidenceExperienceIds), ...candidateIds])];
    if (!await validateSocialAssessmentSourceManifest(tx, characterId, scope.id, observationData.sourceManifest, citedIds)) {
      await tx.socialRelationshipAssessmentReview.create({
        data: { assessmentId, reviewerUserId: actorUserId, decision: "STALE", note: "来源已失效、范围或内容变化，或旧评估未保存来源版本；请重新评估。" },
      });
      await tx.socialRelationshipAssessment.update({ where: { id: assessmentId }, data: { reviewStatus: "STALE", reviewedAt: now, reviewedByUserId: actorUserId } });
      return { decision, reviewStatus: "STALE", applied: false, stale: true };
    }
    if (!candidateIds.length) {
      throw createError({ statusCode: 409, statusMessage: "本次评估没有可用于关系变化的 NEW 经历证据。" });
    }
    const alreadyUsed = await tx.socialRelationChangeEvidence.findMany({
      where: { experienceId: { in: candidateIds }, change: { scopeId: scope.id } },
      select: { experienceId: true },
    });
    const usedIds = new Set(alreadyUsed.map(item => item.experienceId));
    const freshEvidenceIds = candidateIds.filter(id => !usedIds.has(id));
    if (!freshEvidenceIds.length) {
      throw createError({ statusCode: 409, statusMessage: "本次 NEW 经历已用于其他关系变化，请等待新的评估建议。" });
    }

    const updated = await tx.memoryScope.updateMany({
      where: {
        id: scope.id, characterId,
        relationshipVersion: assessment.relationshipVersion,
        relationshipStage: fromStage, relationshipStatus: fromStatus,
      },
      data: {
        relationshipStage: toStage, relationshipStatus: toStatus,
        relationshipVersion: { increment: 1 }, relationshipUpdatedAt: now,
      },
    });
    if (updated.count !== 1) {
      throw createError({ statusCode: 409, statusMessage: "关系信息刚刚发生变化，请刷新后重新确认。" });
    }

    const change = await tx.socialRelationChange.create({
      data: {
        scopeId: scope.id, assessmentId,
        fromStage, toStage, fromStatus, toStatus,
        relationshipVersionBefore: assessment.relationshipVersion,
        relationshipVersionAfter: assessment.relationshipVersion + 1,
        reason: assessment.reason || "人工采纳关系评估建议。",
        idempotencyKey: `assessment:${assessmentId}`,
        evidence: { create: freshEvidenceIds.map(experienceId => ({ experienceId })) },
      },
      select: { id: true },
    });
    await tx.socialRelationshipAssessmentReview.create({
      data: { assessmentId, reviewerUserId: actorUserId, decision: "ACCEPTED", note },
    });
    await tx.socialRelationshipAssessment.update({
      where: { id: assessmentId },
      data: { reviewStatus: "ACCEPTED", reviewedAt: now, reviewedByUserId: actorUserId },
    });
    return { decision, reviewStatus: "ACCEPTED", applied: true, changeId: change.id };
  });
}
