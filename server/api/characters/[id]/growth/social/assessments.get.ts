import { createError, getRouterParam, getQuery } from "h3";
import { requireActorUserId } from "../../../../../utils/auth";
import { readPageQuery, buildPage } from "../../../../../utils/pagination";
import { requireUuid } from "../../../../../utils/local-api";
import { getPrisma } from "../../../../../utils/prisma";
import { readSocialHistoryFilter, socialHistoryFilterWhere, socialAssessmentAvailability } from "../../../../../utils/social-assessment-history";

const DEFAULT_PAGE_SIZE = 12;

export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const character = await getPrisma().character.findFirst({
    where: { id: characterId, ownerId },
    select: { id: true },
  });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });

  const query = getQuery(event);
  const filter = readSocialHistoryFilter(query.filter);
  const { page, pageSize, skip } = readPageQuery(query, {
    defaultPageSize: DEFAULT_PAGE_SIZE,
    maxPageSize: 50,
  });
  const base = {
    scope: {
      characterId,
      character: { ownerId },
      scopeType: "EXTERNAL_IDENTITY" as const,
      externalIdentityId: { not: null },
    },
  };
  const where = { ...base, ...socialHistoryFilterWhere(filter) };
  const prisma = getPrisma();
  const [total, rows, all, actionable, accepted, failed, running] = await Promise.all([
    prisma.socialRelationshipAssessment.count({ where }),
    prisma.socialRelationshipAssessment.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip,
      take: pageSize,
      select: {
        id: true,
        generation: true,
        triggerReasons: true,
        evaluatedStage: true,
        evaluatedStatus: true,
        relationshipVersion: true,
        outcome: true,
        suggestedStage: true,
        suggestedStatus: true,
        reason: true,
        observations: true,
        confidence: true,
        modelName: true,
        promptVersion: true,
        status: true,
        reviewStatus: true,
        reviewedAt: true,
        error: true,
        startedAt: true,
        completedAt: true,
        createdAt: true,
        scope: {
          select: {
            id: true,
            aliases: true,
            relationshipStage: true,
            relationshipStatus: true,
            relationshipVersion: true,
            externalIdentity: {
              select: { platform: true, platformUid: true, displayName: true, kind: true },
            },
          },
        },
        reviews: {
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: { decision: true, note: true, createdAt: true },
        },
        evidence: {
          where: { experience: { scope: { characterId }, memoryEvent: { memoryScope: { characterId } } } },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: {
            id: true,
            kind: true,
            experience: {
              select: {
                id: true,
                scopeId: true,
                assessmentDispatchStatus: true,
                memoryEvent: {
                  select: {
                    id: true,
                    memoryScopeId: true,
                    occurredAt: true,
                    title: true,
                    detail: true,
                    participants: true,
                    confidence: true,
                    status: true,
                  },
                },
              },
            },
          },
        },
      },
    }),
    prisma.socialRelationshipAssessment.count({ where: base }),
    prisma.socialRelationshipAssessment.count({ where: { ...base, ...socialHistoryFilterWhere("ACTIONABLE") } }),
    prisma.socialRelationshipAssessment.count({ where: { ...base, reviewStatus: "ACCEPTED" } }),
    prisma.socialRelationshipAssessment.count({ where: { ...base, status: "FAILED" } }),
    prisma.socialRelationshipAssessment.count({ where: { ...base, status: "RUNNING" } }),
  ]);

  return {
    filter,
    summary: { all, actionable, accepted, failed, running },
    ...buildPage(rows.map((row) => ({
      ...socialAssessmentAvailability(row),
      id: row.id,
      scopeId: row.scope.id,
      friend: {
        displayName: row.scope.aliases[0] || row.scope.externalIdentity?.displayName || "未命名好友",
        platform: row.scope.externalIdentity?.platform ?? "",
        platformUid: row.scope.externalIdentity?.platformUid ?? "",
        kind: row.scope.externalIdentity?.kind ?? "UNKNOWN",
      },
      currentRelationship: {
        stage: row.scope.relationshipStage ?? "STRANGER",
        status: row.scope.relationshipStatus ?? "UNOBSERVED",
        version: row.scope.relationshipVersion,
      },
      generation: row.generation,
      triggerReasons: row.triggerReasons,
      evaluatedStage: row.evaluatedStage,
      evaluatedStatus: row.evaluatedStatus,
      relationshipVersion: row.relationshipVersion,
      outcome: row.outcome,
      suggestedStage: row.suggestedStage,
      suggestedStatus: row.suggestedStatus,
      reason: row.reason,
      observations: row.observations,
      confidence: row.confidence,
      modelName: row.modelName,
      promptVersion: row.promptVersion,
      status: row.status,
      reviewStatus: row.reviewStatus,
      reviewedAt: row.reviewedAt?.toISOString() ?? null,
      reviews: row.reviews.map(review => ({
        decision: review.decision,
        note: review.note,
        createdAt: review.createdAt.toISOString(),
      })),
      error: row.error,
      startedAt: row.startedAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      evidence: row.evidence.filter(item => item.experience.scopeId === row.scope.id).map((item) => ({
        id: item.experience.id,
        kind: item.kind,
        occurredAt: item.experience.memoryEvent.occurredAt.toISOString(),
        title: item.experience.memoryEvent.title,
        detail: item.experience.memoryEvent.detail,
        participants: item.experience.memoryEvent.participants,
        confidence: item.experience.memoryEvent.confidence,
        eventStatus: item.experience.memoryEvent.status,
      })),
    })), total, page, pageSize),
  };
});
