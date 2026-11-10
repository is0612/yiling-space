import { createError } from "h3";
import type { Prisma } from "../../src/generated/prisma/client";

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
