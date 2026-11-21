/**
 * 成长域的前后端共享契约。
 *
 * 这里只放**会过 HTTP 边界的形状**，不放 Prisma 模型、不放服务端逻辑：
 * - 日期一律 `string`（JSON 传输后就是 ISO 字符串，前后端同一份）；
 * - 枚举以 `as const` 数组为准，类型由数组派生，服务端的校验与前端下拉共用一份；
 * - 字段名与 `docs/openapi.yaml` 中的 schema 保持一致。
 *
 * 修改这里的字段等于改 API 契约：服务端的 `publicGoal` 会立刻报类型错误，
 * 前端页面也会在 `yarn typecheck` 里暴露，不再有「三份定义各自漂移」的空间。
 */

export const GOAL_KINDS = ["GOAL", "WISH"] as const;
export type GoalKind = typeof GOAL_KINDS[number];

export const GOAL_STATUSES = ["PENDING", "ACTIVE", "PAUSED", "COMPLETED", "ABANDONED", "REJECTED"] as const;
export type GoalStatus = typeof GOAL_STATUSES[number];

export type GrowthSourceType = "MEMORY_EVENT" | "REFLECTION_SUGGESTION";
export type GrowthSource = {
  type: GrowthSourceType;
  id: string;
  title: string;
  summary: string;
  hash: string;
  occurredAt?: string;
};

export type GrowthPagination = { page: number; pageSize: number; total: number; pageCount: number };
export type GrowthPage<T> = { items: T[]; pagination: GrowthPagination };

export type GoalProgress = {
  id: string;
  goalId: string;
  content: string;
  sourceRefs: GrowthSource[];
  createdAt: string;
};

export type Goal = {
  id: string;
  characterId: string;
  kind: GoalKind;
  title: string;
  description: string;
  reason: string;
  status: GoalStatus;
  revision: number;
  sourceType: "MANUAL" | "SOURCES";
  sourceRefs: GrowthSource[];
  createdAt: string;
  updatedAt: string;
  progressCount?: number;
  latestProgress?: GoalProgress | null;
};

export type GoalHistory = Goal & { action: string };
export type GoalSuggestion = { kind: GoalKind; title: string; description: string; reason: string };
