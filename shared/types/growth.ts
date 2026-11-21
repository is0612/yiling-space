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

// ── 反思（周期回顾产出可采纳的结论） ──────────────────────────────

export type ReflectionSourceRef = {
  key: string;
  type: "memory" | "knowledge" | "snapshot" | "experience";
  id: string;
  title: string;
  hash: string;
  excerpt: string;
};

export const REFLECTION_SUGGESTION_STATUSES = ["PENDING", "ACCEPTED", "REJECTED", "DEFERRED"] as const;
export type ReflectionSuggestionStatus = typeof REFLECTION_SUGGESTION_STATUSES[number];
export type ReflectionDecision = "ACCEPTED" | "REJECTED" | "DEFERRED";

export type ReflectionSuggestion = {
  id: string;
  title: string;
  observation: string;
  inference: string;
  recommendation: string;
  sourceRefs: ReflectionSourceRef[];
  status: ReflectionSuggestionStatus;
  reviewNote: string | null;
  reviewedAt: string | null;
  acceptedAt: string | null;
};

export type ReflectionRun = {
  id: string;
  periodStart: string;
  periodEnd: string;
  status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED";
  attemptCount: number;
  maxAttempts: number;
  runAt: string;
  lastError: string | null;
  model: string | null;
  promptVersion: string | null;
  createdAt: string;
  completedAt: string | null;
  conversationId?: string | null;
  memoryScopeId?: string | null;
  suggestions: ReflectionSuggestion[];
};

export type ReflectionList = {
  items: ReflectionRun[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  hasMore: boolean;
};

export type ReflectionDeleteResult = { deletedRuns: number; deletedSuggestions: number };

// ── 事件投递（内部队列的可观测视图） ──────────────────────────────

export const DELIVERY_STATUSES = ["QUEUED", "RUNNING", "SUCCEEDED", "RETRY_WAIT", "FAILED", "SKIPPED", "CANCELLED"] as const;
export type DeliveryStatus = typeof DELIVERY_STATUSES[number];

export type Delivery = {
  id: string;
  eventId: string;
  consumerKey: string;
  status: DeliveryStatus;
  attemptCount: number;
  maxAttempts: number;
  runAt: string;
  lockedAt: string | null;
  lockedBy: string | null;
  leaseExpiresAt: string | null;
  fencingToken: number;
  lastError: string | null;
  processedAt: string | null;
  createdAt: string;
  updatedAt: string;
  eventType: string;
  sourceDomain: string;
  aggregateType: string;
  aggregateId: string;
  occurredAt: string;
  leaseExpired: boolean;
  queueDelayMs: number;
};

export type DeliveryDetail = Delivery & {
  audits: Array<{ id: string; actorType: string; actorId: string | null; createdAt: string; details: unknown }>;
};

export type DeliverySummary = {
  statusCounts: Record<DeliveryStatus, number>;
  readyCount: number;
  stuckCount: number;
  oldestReadyAt: string | null;
};

export type DeliveryList = {
  items: Delivery[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  hasMore: boolean;
  summary: DeliverySummary;
};

// ── 关系评估（她自己判断和某个人的关系走到哪一步） ──────────────────

export const ASSESSMENT_FILTERS = ["ALL", "ACTIONABLE", "ACCEPTED", "REJECTED", "STALE", "FAILED", "RUNNING"] as const;
export type AssessmentFilter = typeof ASSESSMENT_FILTERS[number];
export type AssessmentDecision = "ACCEPTED" | "REJECTED" | "DEFERRED";

export type AssessmentEvidence = {
  id: string;
  kind: "NEW" | "CONTEXT";
  occurredAt: string;
  title: string;
  detail: string;
  participants: string[];
  confidence: number | null;
  eventStatus: string;
};

export type Assessment = {
  id: string;
  scopeId: string;
  friend: { displayName: string; platform: string; platformUid: string; kind: string };
  currentRelationship: { stage: string; status: string; version: number };
  generation: number;
  triggerReasons: string[];
  evaluatedStage: string;
  evaluatedStatus: string;
  relationshipVersion: number;
  outcome: string | null;
  suggestedStage: string | null;
  suggestedStatus: string | null;
  reason: string | null;
  observations: unknown;
  confidence: number | null;
  modelName: string | null;
  promptVersion: string | null;
  status: string;
  reviewStatus: string;
  reviewedAt: string | null;
  reviews: { decision: string; note: string | null; createdAt: string }[];
  error: string | null;
  startedAt: string;
  completedAt: string | null;
  createdAt: string;
  evidence: AssessmentEvidence[];
  canReview: boolean;
  staleReason: string | null;
};

export type AssessmentPersonGroup = {
  scopeId: string;
  friend: Assessment["friend"];
  currentRelationship: Assessment["currentRelationship"];
  assessmentCount: number;
  matchingCount: number;
  latestAssessment: Pick<Assessment, "id" | "status" | "outcome" | "reviewStatus" | "createdAt"> | null;
  changes: {
    id: string;
    fromStage: string;
    toStage: string;
    fromStatus: string | null;
    toStatus: string | null;
    createdAt: string;
  }[];
  changeCount: number;
};

export type AssessmentSummary = { all: number; actionable: number; accepted: number; failed: number; running: number };

export type AssessmentPeopleResult = {
  items: AssessmentPersonGroup[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  summary: AssessmentSummary;
};

export type AssessmentPageResult = {
  items: Assessment[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  hasMore: boolean;
  summary: AssessmentSummary;
};

export type AssessmentReviewResult = { applied: boolean; stale?: boolean };

// ── 成长概览（一段时间里她变化了什么） ────────────────────────────

export type GrowthOverviewConclusion = {
  id: string;
  title: string;
  observation: string;
  inference: string;
  recommendation: string;
  acceptedAt: string;
  sourceRefs: unknown[];
};

export type GrowthOverview = {
  character: { id: string; name: string };
  period: { days: number; start: string; end: string };
  generatedAt: string;
  stats: { memories: number; knowledge: number; relationships: number; conclusions: number };
  pending: { reflections: number; knowledge: number; relationships: number };
  conclusions: GrowthOverviewConclusion[];
  timeline: {
    id: string;
    type: "reflection" | "knowledge" | "relationship" | "snapshot";
    title: string;
    at: string;
    description: string;
    href: string;
  }[];
  delivery: { failed: number; stuck: number; ready: number };
};

// ── 互动指引（她学到的相处方式） ────────────────────────────────

export const GUIDANCE_STATUSES = ["PENDING", "ACTIVE", "DISABLED", "REJECTED"] as const;
export type GuidanceStatus = typeof GUIDANCE_STATUSES[number];

export const GUIDANCE_KINDS = ["UNDERSTANDING", "REFERENCE", "SITUATION", "STRATEGY"] as const;
export type GuidanceKind = typeof GUIDANCE_KINDS[number];

export type GuidanceItem = {
  id: string;
  characterId: string;
  kind: GuidanceKind;
  content: string;
  context: string;
  chatScope: ChatScope;
  reason: string;
  status: GuidanceStatus;
  revision: number;
  sourceRefs?: unknown[];
  createdAt: string;
  updatedAt: string;
  action?: string;
};

/** 渠道策略：目前只有「群里 @ 她不回」这一类。 */
export type ChannelPolicyItem = {
  id: string;
  characterId: string;
  kind: "GROUP_AT_DISABLED";
  chatScope: "GROUP";
  content: string;
  status: GuidanceStatus;
  revision: number;
  sourceRefs?: unknown[];
  createdAt: string;
  updatedAt?: string;
  action?: string;
};
