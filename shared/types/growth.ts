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

/**
 * 历史条目 = `character_goal_revisions` 的一行（`GET /growth/goals/{id}/history` 的真实响应）。
 *
 * 注意它与 `Goal` **不是**同一个形状：修订行没有 `characterId` / `updatedAt` /
 * `progressCount` / `latestProgress`，但多出 `goalId` / `actorId`。早先把它写成
 * `Goal & { action }` 是错的 —— 页面上读 `entry.characterId` 只会拿到 undefined。
 */
export type GoalHistory = {
  id: string;
  goalId: string;
  revision: number;
  action: string;
  kind: GoalKind;
  title: string;
  description: string;
  reason: string;
  status: GoalStatus;
  sourceType: "MANUAL" | "SOURCES";
  sourceRefs: GrowthSource[];
  actorId: string;
  createdAt: string;
};
export type GoalSuggestion = { kind: GoalKind; title: string; description: string; reason: string };

export const PREFERENCE_KINDS = ["LIKE", "DISLIKE", "INTEREST"] as const;
export type PreferenceKind = typeof PREFERENCE_KINDS[number];

export const PREFERENCE_STATUSES = ["PENDING", "ACTIVE", "REJECTED", "DISABLED"] as const;
export type PreferenceStatus = typeof PREFERENCE_STATUSES[number];

export type Preference = {
  id: string;
  characterId: string;
  kind: PreferenceKind;
  topic: string;
  reason: string;
  status: PreferenceStatus;
  revision: number;
  sourceType: "MANUAL" | "SOURCES";
  sourceRefs: GrowthSource[];
  createdAt: string;
  updatedAt: string;
};

/** 历史条目 = `character_preference_revisions` 的一行；同样没有 `characterId` / `updatedAt`。 */
export type PreferenceHistory = {
  id: string;
  preferenceId: string;
  revision: number;
  action: string;
  kind: PreferenceKind;
  topic: string;
  reason: string;
  status: PreferenceStatus;
  sourceType: "MANUAL" | "SOURCES";
  sourceRefs: GrowthSource[];
  actorId: string;
  createdAt: string;
};

export type PreferenceSuggestion = { kind: PreferenceKind; topic: string; reason: string };

/** 表达习惯（前端旧名 Language*）的适用范围：全局 / 群 / 私聊。 */
export const EXPRESSION_CHAT_SCOPES = ["ALL", "GROUP", "PRIVATE"] as const;
export type ChatScope = typeof EXPRESSION_CHAT_SCOPES[number];

export const LANGUAGE_KINDS = ["TONE", "WORDING", "LENGTH"] as const;
export type LanguageKind = typeof LANGUAGE_KINDS[number];

export const LANGUAGE_STATUSES = ["PENDING", "ACTIVE", "REJECTED", "DISABLED"] as const;
export type LanguageStatus = typeof LANGUAGE_STATUSES[number];

/** 群聊观察来源选中的三条消息（开场 / 接话 / 后续）。 */
export type GroupObservationSelection = {
  conversationId: string;
  openingId: string;
  responseId: string;
  outcomeId: string;
};

/**
 * 表达习惯的来源引用：四种来源写进 `sourceRefs` 的形状**各不相同**，这里按真实结构
 * 定义联合类型，而不是统一成 `GrowthSource`。
 *
 * 早先统一成 `GrowthSource[]` 是类型谎言：GROUP_OBSERVATION 的引用根本没有
 * `id` / `title`，页面却拿它拼 key、读标题。按来源分支写，页面才会在
 * `yarn typecheck` 里暴露「这里没有 title」。
 */
export type LanguageHabitSourceRef =
  /** SOURCES：手动选择的公开来源，保存时快照（`PreferenceSourceSnapshot`）。 */
  | { type: GrowthSourceType; id: string; hash: string; title: string; summary: string }
  /** GROUP_OBSERVATION：一段群聊观察，只有选择定位与校准哈希。 */
  | { type: "GROUP_OBSERVATION"; selection: GroupObservationSelection; hash: string }
  /** EXPERIENCE_REFLECT：本会话经验反思，带会话与范围锚点，不含原文。 */
  | { key: string; type: "experience"; id: string; hash: string; conversationId: string; memoryScopeId: string }
  /** EDUCATION_TRANSFER：已授权教育反馈来源，带反馈消息与提案人身份。 */
  | {
      version: 1;
      type: "experience";
      key: string;
      id: string;
      hash: string;
      conversationId: string;
      memoryScopeId: string;
      feedbackMessageId: string;
      educationMode: "explicit" | "repeated";
      proposer: { kind: "owner" | "authorized"; platform: "desktop" | "qq-onebot"; identity: string };
    };

export type LanguageHabit = {
  id: string;
  characterId: string;
  kind: LanguageKind;
  chatScope?: ChatScope;
  content: string;
  context: string;
  reason: string;
  status: LanguageStatus;
  /** OWNER = 你审核；SELF = 她自己审核后生效。 */
  reviewedBy?: "OWNER" | "SELF" | null;
  reviewedAt?: string | null;
  revision: number;
  sourceType: "MANUAL" | "SOURCES" | "EXPERIENCE_REFLECT" | "EDUCATION_TRANSFER" | "GROUP_OBSERVATION";
  conversationId?: string | null;
  memoryScopeId?: string | null;
  sourceRefs: LanguageHabitSourceRef[];
  createdAt: string;
  updatedAt: string;
};

/**
 * 历史条目 = `character_expression_habit_revisions` 的一行。
 * 修订行没有 `characterId` / `updatedAt` / `reviewedBy` / `reviewedAt`。
 */
export type LanguageHistory = {
  id: string;
  habitId: string;
  revision: number;
  action: string;
  kind: LanguageKind;
  content: string;
  context: string;
  chatScope?: ChatScope;
  reason: string;
  status: LanguageStatus;
  sourceType: LanguageHabit["sourceType"];
  sourceRefs: LanguageHabitSourceRef[];
  conversationId?: string | null;
  memoryScopeId?: string | null;
  actorId: string;
  createdAt: string;
};
export type LanguageSuggestion = { kind: LanguageKind; content: string; context: string; reason: string };
