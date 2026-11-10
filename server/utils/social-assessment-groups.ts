import { createError } from "h3";
import type { Prisma, PrismaClient } from "../../src/generated/prisma/client";
import { buildPage } from "./pagination";
import { socialHistoryFilterWhere, type SocialHistoryFilter } from "./social-assessment-history";

export function readSocialAssessmentView(value: unknown): "records" | "people" {
  if (value === undefined || value === "records") return "records";
  if (value === "people") return "people";
  throw createError({ statusCode: 400, statusMessage: "评估历史视图无效。" });
}

export type SocialAssessmentGroupScope = {
  id: string; aliases: string[]; relationshipStage: string | null; relationshipStatus: string | null; relationshipVersion: number;
  externalIdentity: { platform: string; platformUid: string; displayName: string | null; kind: string } | null;
  _count: { socialAssessments: number; socialRelationChanges: number };
  socialAssessments: Array<{ id: string; status: string; outcome: string | null; reviewStatus: string; createdAt: Date }>;
  socialRelationChanges: Array<{ id: string; fromStage: string; toStage: string; fromStatus: string | null; toStatus: string | null; createdAt: Date }>;
};
/** Only persisted relation changes express progression; proposed assessments never become milestones. */
export function toSocialAssessmentGroup(scope: SocialAssessmentGroupScope, matchingCount: number) {
  const latest = scope.socialAssessments[0];
  return {
    scopeId: scope.id,
    friend: { displayName: scope.aliases[0] || scope.externalIdentity?.displayName || "未命名好友", platform: scope.externalIdentity?.platform ?? "", platformUid: scope.externalIdentity?.platformUid ?? "", kind: scope.externalIdentity?.kind ?? "UNKNOWN" },
    currentRelationship: { stage: scope.relationshipStage ?? "STRANGER", status: scope.relationshipStatus ?? "UNOBSERVED", version: scope.relationshipVersion },
    assessmentCount: scope._count.socialAssessments,
    matchingCount,
    latestAssessment: latest ? { ...latest, createdAt: latest.createdAt.toISOString() } : null,
    changes: [...scope.socialRelationChanges].reverse().map(change => ({ ...change, createdAt: change.createdAt.toISOString() })),
    changeCount: scope._count.socialRelationChanges,
  };
}

export async function listSocialAssessmentGroups(prisma: PrismaClient, input: { characterId: string; ownerId: string; filter: SocialHistoryFilter; scopeId?: string; page: number; pageSize: number; skip: number }) {
  const scopeWhere: Prisma.MemoryScopeWhereInput = { characterId: input.characterId, character: { ownerId: input.ownerId }, scopeType: "EXTERNAL_IDENTITY", externalIdentityId: { not: null }, ...(input.scopeId ? { id: input.scopeId } : {}) };
  const assessmentWhere: Prisma.SocialRelationshipAssessmentWhereInput = { scope: scopeWhere, ...socialHistoryFilterWhere(input.filter) };
  const [total, grouped] = await Promise.all([
    prisma.memoryScope.count({ where: { ...scopeWhere, socialAssessments: { some: socialHistoryFilterWhere(input.filter) } } }),
    prisma.socialRelationshipAssessment.groupBy({ by: ["scopeId"], where: assessmentWhere, _count: { _all: true }, _max: { createdAt: true }, orderBy: [{ _max: { createdAt: "desc" } }, { scopeId: "asc" }], skip: input.skip, take: input.pageSize }),
  ]);
  const rows = grouped.length ? await prisma.memoryScope.findMany({
    where: { ...scopeWhere, id: { in: grouped.map(row => row.scopeId) } },
    select: {
      id: true, aliases: true, relationshipStage: true, relationshipStatus: true, relationshipVersion: true,
      externalIdentity: { select: { platform: true, platformUid: true, displayName: true, kind: true } },
      _count: { select: { socialAssessments: true, socialRelationChanges: true } },
      socialAssessments: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1, select: { id: true, status: true, outcome: true, reviewStatus: true, createdAt: true } },
      socialRelationChanges: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 20, select: { id: true, fromStage: true, toStage: true, fromStatus: true, toStatus: true, createdAt: true } },
    },
  }) : [];
  const byId = new Map(rows.map(row => [row.id, row]));
  return buildPage(grouped.flatMap(row => { const scope = byId.get(row.scopeId); return scope ? [toSocialAssessmentGroup(scope, row._count._all)] : []; }), total, input.page, input.pageSize);
}
