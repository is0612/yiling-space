import { createError } from "h3";
import type { Prisma } from "../../src/generated/prisma/client";
import { hashSocialAssessmentSource, readSocialAssessmentSourceManifest } from "./social-assessment-evidence";

type HistorySource = { id: string; memoryScopeId: string; status: string; title: string; detail: string; occurredAt: Date; participants: string[]; confidence: number | null };
type HistoryAssessment = {
  status: string; outcome: string | null; reviewStatus: string; relationshipVersion: number; evaluatedStage: string; evaluatedStatus: string;
  observations: unknown;
  scope: { id: string; relationshipVersion: number; relationshipStage: string | null; relationshipStatus: string | null };
  evidence: Array<{ kind: string; experience: { id: string; scopeId: string; assessmentDispatchStatus: string; memoryEvent: HistorySource } }>;
};
/** Read-only preview of the same NEW + cited evidence required by the acceptance transaction. */
export function socialAssessmentAvailability(row: HistoryAssessment) {
  if (row.status !== "SUCCEEDED" || row.outcome !== "CHANGE" || !["PENDING", "DEFERRED"].includes(row.reviewStatus)) return { canReview: false, staleReason: null };
  if (row.relationshipVersion !== row.scope.relationshipVersion || row.evaluatedStage !== (row.scope.relationshipStage ?? "STRANGER") || row.evaluatedStatus !== (row.scope.relationshipStatus ?? "UNOBSERVED")) return { canReview: false, staleReason: "当前关系已变化，请重新评估。" };
  const data = row.observations && typeof row.observations === "object" && !Array.isArray(row.observations) ? row.observations as Record<string, unknown> : {};
  const strings = (value: unknown) => Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  const newIds = new Set(strings(data.newEvidenceExperienceIds));
  const candidateIds = row.evidence.filter(item => item.kind === "NEW" && newIds.has(item.experience.id)).map(item => item.experience.id);
  const requiredIds = [...new Set([...strings(data.evidenceExperienceIds), ...candidateIds])];
  const manifest = readSocialAssessmentSourceManifest(data.sourceManifest);
  const sources = new Map(manifest.map(source => [source.experienceId, source]));
  const valid = candidateIds.length > 0 && Array.isArray(data.sourceManifest) && manifest.length === data.sourceManifest.length && sources.size === manifest.length && requiredIds.every(id => {
    const old = sources.get(id);
    const experience = row.evidence.find(item => item.experience.id === id)?.experience;
    const current = experience?.memoryEvent;
    return old && experience && experience.scopeId === row.scope.id && ["LEGACY", "QUEUED"].includes(experience.assessmentDispatchStatus)
      && current && current.status === "ACTIVE" && old.memoryEventId === current.id && old.sourceScopeId === current.memoryScopeId && old.sourceHash === hashSocialAssessmentSource(current);
  });
  return { canReview: Boolean(valid), staleReason: valid ? null : "来源已变化、缺失或旧记录未保存版本证据，请重新评估；仍可驳回或暂缓。" };
}

export const SOCIAL_HISTORY_FILTERS = ["ALL", "ACTIONABLE", "ACCEPTED", "REJECTED", "STALE", "FAILED", "RUNNING"] as const;
export type SocialHistoryFilter = typeof SOCIAL_HISTORY_FILTERS[number];
export function readSocialHistoryFilter(value: unknown): SocialHistoryFilter {
  if (value === undefined || value === "") return "ALL";
  if (typeof value !== "string" || !SOCIAL_HISTORY_FILTERS.includes(value as SocialHistoryFilter)) throw createError({ statusCode: 400, statusMessage: "评估历史筛选无效。" });
  return value as SocialHistoryFilter;
}
export function socialHistoryFilterWhere(filter: SocialHistoryFilter): Prisma.SocialRelationshipAssessmentWhereInput {
  if (filter === "ACTIONABLE") return { status: "SUCCEEDED", outcome: "CHANGE", reviewStatus: { in: ["PENDING", "DEFERRED"] } };
  if (filter === "FAILED" || filter === "RUNNING") return { status: filter };
  if (["ACCEPTED", "REJECTED", "STALE"].includes(filter)) return { reviewStatus: filter as "ACCEPTED" | "REJECTED" | "STALE" };
  return {};
}
