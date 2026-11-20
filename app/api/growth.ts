import type { ApiRequest } from "../utils/request";

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

export type GoalKind = "GOAL" | "WISH";
export type GoalStatus = "ACTIVE" | "PENDING" | "PAUSED" | "COMPLETED" | "ABANDONED" | "REJECTED";
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

export type PreferenceKind = "LIKE" | "DISLIKE" | "INTEREST";
export type PreferenceStatus = "ACTIVE" | "PENDING" | "DISABLED" | "REJECTED";
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
export type PreferenceHistory = {
  id: string;
  revision: number;
  kind: PreferenceKind;
  topic: string;
  reason: string;
  status: PreferenceStatus;
  operation?: string;
  action?: string;
  createdAt: string;
};
export type PreferenceSuggestion = { kind: PreferenceKind; topic: string; reason: string };

export type ChatScope = "ALL" | "GROUP" | "PRIVATE";
export type LanguageKind = "TONE" | "WORDING" | "LENGTH";
export type LanguageStatus = "ACTIVE" | "PENDING" | "DISABLED" | "REJECTED";
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
  sourceRefs: GrowthSource[];
  createdAt: string;
  updatedAt: string;
};
export type LanguageHistory = LanguageHabit & { action: string };
export type LanguageSuggestion = { kind: LanguageKind; content: string; context: string; reason: string };

export type ReflectionSourceRef = {
  key: string;
  type: "memory" | "knowledge" | "snapshot" | "experience";
  id: string;
  title: string;
  hash: string;
  excerpt: string;
};
export type ReflectionSuggestionStatus = "PENDING" | "ACCEPTED" | "REJECTED" | "DEFERRED";
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
export type ReflectionDecision = "ACCEPTED" | "REJECTED" | "DEFERRED";
export type ReflectionDeleteResult = { deletedRuns: number; deletedSuggestions: number };

export type DeliveryStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "RETRY_WAIT" | "FAILED" | "SKIPPED" | "CANCELLED";
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

export type AssessmentFilter = "ALL" | "ACTIONABLE" | "ACCEPTED" | "REJECTED" | "STALE" | "FAILED" | "RUNNING";
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

export type GuidanceStatus = "PENDING" | "ACTIVE" | "DISABLED" | "REJECTED";
export type GuidanceKind = "UNDERSTANDING" | "REFERENCE" | "SITUATION" | "STRATEGY";
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

const characterBase = (characterId: string) => `/characters/${encodeURIComponent(characterId)}`;
const goalBase = (characterId: string) => `${characterBase(characterId)}/growth/goals`;
const goalPath = (characterId: string, goalId: string) => `${goalBase(characterId)}/${encodeURIComponent(goalId)}`;
const preferenceBase = (characterId: string) => `${characterBase(characterId)}/growth/preferences`;
const preferencePath = (characterId: string, preferenceId: string) =>
  `${preferenceBase(characterId)}/${encodeURIComponent(preferenceId)}`;
const languageBase = (characterId: string) => `${characterBase(characterId)}/growth/language`;
const languagePath = (characterId: string, habitId: string) =>
  `${languageBase(characterId)}/${encodeURIComponent(habitId)}`;
const reflectionBase = (characterId: string) => `${characterBase(characterId)}/growth/reflections`;
const reflectionPath = (characterId: string, reflectionId: string) =>
  `${reflectionBase(characterId)}/${encodeURIComponent(reflectionId)}`;
const deliveryBase = (characterId: string) => `${characterBase(characterId)}/growth/deliveries`;
const deliveryPath = (characterId: string, deliveryId: string) =>
  `${deliveryBase(characterId)}/${encodeURIComponent(deliveryId)}`;
const assessmentBase = (characterId: string) => `${characterBase(characterId)}/growth/social/assessments`;
const assessmentPath = (characterId: string, assessmentId: string) =>
  `${assessmentBase(characterId)}/${encodeURIComponent(assessmentId)}`;
const guidanceBase = (characterId: string) => `${characterBase(characterId)}/growth/interaction-guidance`;
const guidancePath = (characterId: string, guidanceId: string) =>
  `${guidanceBase(characterId)}/${encodeURIComponent(guidanceId)}`;
const channelPolicyBase = (characterId: string) => `${characterBase(characterId)}/growth/channel-policies`;
const channelPolicyPath = (characterId: string, policyId: string) =>
  `${channelPolicyBase(characterId)}/${encodeURIComponent(policyId)}`;

/**
 * 成长系统接口：愿望、偏好、表达习惯、反思、投递、关系评估、总览、长期指导与渠道行为。
 *
 * 只声明端点与出入参；角色代际、请求序号、过期响应、乐观版本和提示文案留在页面里。
 */
export function createGrowthApi(request: ApiRequest) {
  function listGoals(payload: {
    characterId: string;
    status: string;
    keyword: string;
    page: number;
    pageSize?: number;
  }): Promise<GrowthPage<Goal>> {
    return request<GrowthPage<Goal>>({
      url: goalBase(payload.characterId),
      method: "get",
      params: {
        status: payload.status,
        q: payload.keyword,
        page: payload.page,
        pageSize: payload.pageSize ?? 20,
      },
    });
  }

  function listGoalSources(payload: {
    characterId: string;
    type: GrowthSourceType;
    keyword: string;
    page: number;
    pageSize?: number;
  }): Promise<GrowthPage<GrowthSource>> {
    return request<GrowthPage<GrowthSource>>({
      url: `${goalBase(payload.characterId)}/sources`,
      method: "get",
      params: { type: payload.type, q: payload.keyword, page: payload.page, pageSize: payload.pageSize ?? 10 },
    });
  }

  function suggestGoal(payload: {
    characterId: string;
    sources: Array<Pick<GrowthSource, "type" | "id" | "hash">>;
  }): Promise<{ suggestion: GoalSuggestion | null }> {
    return request<{ suggestion: GoalSuggestion | null }>({
      url: `${goalBase(payload.characterId)}/suggest`,
      method: "post",
      data: { sources: payload.sources },
    });
  }

  function saveGoal(payload: {
    characterId: string;
    goalId?: string;
    data: Record<string, unknown>;
  }): Promise<unknown> {
    return payload.goalId
      ? request<unknown>({ url: goalPath(payload.characterId, payload.goalId), method: "patch", data: payload.data })
      : request<unknown>({ url: goalBase(payload.characterId), method: "post", data: payload.data });
  }

  function listGoalHistory(payload: {
    characterId: string;
    goalId: string;
    page: number;
    pageSize?: number;
  }): Promise<GrowthPage<GoalHistory>> {
    return request<GrowthPage<GoalHistory>>({
      url: `${goalPath(payload.characterId, payload.goalId)}/history`,
      method: "get",
      params: { page: payload.page, pageSize: payload.pageSize ?? 10 },
    });
  }

  function listGoalProgress(payload: {
    characterId: string;
    goalId: string;
    page: number;
    pageSize?: number;
  }): Promise<GrowthPage<GoalProgress>> {
    return request<GrowthPage<GoalProgress>>({
      url: `${goalPath(payload.characterId, payload.goalId)}/progress`,
      method: "get",
      params: { page: payload.page, pageSize: payload.pageSize ?? 10 },
    });
  }

  function createGoalProgress(payload: {
    characterId: string;
    goalId: string;
    expectedRevision: number;
    requestKey: string;
    content: string;
  }): Promise<{ goal: Goal; progress: GoalProgress; created?: boolean }> {
    return request<{ goal: Goal; progress: GoalProgress; created?: boolean }>({
      url: `${goalPath(payload.characterId, payload.goalId)}/progress`,
      method: "post",
      data: { expectedRevision: payload.expectedRevision, requestKey: payload.requestKey, content: payload.content },
    });
  }

  function listPreferences(payload: {
    characterId: string;
    status: string;
    keyword: string;
    page: number;
    pageSize?: number;
  }): Promise<GrowthPage<Preference>> {
    return request<GrowthPage<Preference>>({
      url: preferenceBase(payload.characterId),
      method: "get",
      params: {
        status: payload.status,
        q: payload.keyword,
        page: payload.page,
        pageSize: payload.pageSize ?? 20,
      },
    });
  }

  function listPreferenceSources(payload: {
    characterId: string;
    type: GrowthSourceType;
    keyword: string;
    page: number;
    pageSize?: number;
  }): Promise<GrowthPage<GrowthSource>> {
    return request<GrowthPage<GrowthSource>>({
      url: `${preferenceBase(payload.characterId)}/sources`,
      method: "get",
      params: { type: payload.type, q: payload.keyword, page: payload.page, pageSize: payload.pageSize ?? 10 },
    });
  }

  function suggestPreference(payload: {
    characterId: string;
    sources: Array<Pick<GrowthSource, "type" | "id" | "hash">>;
  }): Promise<{ suggestion: PreferenceSuggestion | null }> {
    return request<{ suggestion: PreferenceSuggestion | null }>({
      url: `${preferenceBase(payload.characterId)}/suggest`,
      method: "post",
      data: { sources: payload.sources },
    });
  }

  function savePreference(payload: {
    characterId: string;
    preferenceId?: string;
    data: Record<string, unknown>;
  }): Promise<unknown> {
    return payload.preferenceId
      ? request<unknown>({
          url: preferencePath(payload.characterId, payload.preferenceId),
          method: "patch",
          data: payload.data,
        })
      : request<unknown>({ url: preferenceBase(payload.characterId), method: "post", data: payload.data });
  }

  function listPreferenceHistory(payload: {
    characterId: string;
    preferenceId: string;
    page: number;
    pageSize?: number;
  }): Promise<GrowthPage<PreferenceHistory>> {
    return request<GrowthPage<PreferenceHistory>>({
      url: `${preferencePath(payload.characterId, payload.preferenceId)}/history`,
      method: "get",
      params: { page: payload.page, pageSize: payload.pageSize ?? 10 },
    });
  }

  function listLanguageHabits(payload: {
    characterId: string;
    status: string;
    keyword: string;
    page: number;
    pageSize?: number;
  }): Promise<GrowthPage<LanguageHabit>> {
    return request<GrowthPage<LanguageHabit>>({
      url: languageBase(payload.characterId),
      method: "get",
      params: {
        status: payload.status,
        q: payload.keyword,
        page: payload.page,
        pageSize: payload.pageSize ?? 20,
      },
    });
  }

  function listLanguageSources(payload: {
    characterId: string;
    type: GrowthSourceType;
    keyword: string;
    page: number;
    pageSize?: number;
  }): Promise<GrowthPage<GrowthSource>> {
    return request<GrowthPage<GrowthSource>>({
      url: `${languageBase(payload.characterId)}/sources`,
      method: "get",
      params: { type: payload.type, q: payload.keyword, page: payload.page, pageSize: payload.pageSize ?? 10 },
    });
  }

  function suggestLanguageHabit(payload: {
    characterId: string;
    sources: Array<Pick<GrowthSource, "type" | "id" | "hash">>;
  }): Promise<{ suggestion: LanguageSuggestion | null }> {
    return request<{ suggestion: LanguageSuggestion | null }>({
      url: `${languageBase(payload.characterId)}/suggest`,
      method: "post",
      data: { sources: payload.sources },
    });
  }

  function selfReviewLanguageHabits(characterId: string): Promise<{
    reviewed: Array<{ id: string; status: string }>; remaining: number; used: number; limit: number; skipped: string | null;
  }> {
    return request({ url: `${languageBase(characterId)}/self-review`, method: "post" });
  }

  function observeGroupLanguage(characterId: string, selection: { conversationId: string; openingId: string; responseId: string; outcomeId: string }) {
    return request<{ habit: LanguageHabit | null; reused: boolean }>({
      url: `${languageBase(characterId)}/observe-group`, method: "post", data: selection,
    });
  }

  function setAutomaticGroupLanguage(characterId: string, conversationId: string, enabled: boolean) {
    return request<{ enabled: boolean }>({ url: `${languageBase(characterId)}/observe-group`, method: "patch", data: { conversationId, enabled } });
  }

  function saveLanguageHabit(payload: {
    characterId: string;
    habitId?: string;
    data: Record<string, unknown>;
  }): Promise<unknown> {
    return payload.habitId
      ? request<unknown>({ url: languagePath(payload.characterId, payload.habitId), method: "patch", data: payload.data })
      : request<unknown>({ url: languageBase(payload.characterId), method: "post", data: payload.data });
  }

  function listLanguageHistory(payload: {
    characterId: string;
    habitId: string;
    page: number;
    pageSize?: number;
  }): Promise<GrowthPage<LanguageHistory>> {
    return request<GrowthPage<LanguageHistory>>({
      url: `${languagePath(payload.characterId, payload.habitId)}/history`,
      method: "get",
      params: { page: payload.page, pageSize: payload.pageSize ?? 10 },
    });
  }

  function listReflections(payload: {
    characterId: string;
    page: number;
    pageSize?: number;
  }): Promise<ReflectionList> {
    return request<ReflectionList>({
      url: reflectionBase(payload.characterId),
      method: "get",
      params: { page: payload.page, pageSize: payload.pageSize ?? 20 },
    });
  }

  function createReflection(payload: {
    characterId: string;
    requestKey: string;
    days: number;
  }): Promise<{ run: ReflectionRun; created: boolean }> {
    return request<{ run: ReflectionRun; created: boolean }>({
      url: reflectionBase(payload.characterId),
      method: "post",
      data: { requestKey: payload.requestKey, days: payload.days },
    });
  }

  function retryReflection(payload: { characterId: string; reflectionId: string }): Promise<unknown> {
    return request<unknown>({
      url: `${reflectionPath(payload.characterId, payload.reflectionId)}/retry`,
      method: "post",
      data: {},
    });
  }

  function reviewReflectionSuggestion(payload: {
    characterId: string;
    suggestionId: string;
    decision: ReflectionDecision;
    note?: string;
  }): Promise<{ suggestion: ReflectionSuggestion }> {
    return request<{ suggestion: ReflectionSuggestion }>({
      url: `${reflectionBase(payload.characterId)}/suggestions/${encodeURIComponent(payload.suggestionId)}/review`,
      method: "post",
      data: { decision: payload.decision, ...(payload.note ? { note: payload.note } : {}) },
    });
  }

  function deleteReflection(payload: { characterId: string; reflectionId?: string }): Promise<ReflectionDeleteResult> {
    return request<ReflectionDeleteResult>({
      url: payload.reflectionId
        ? reflectionPath(payload.characterId, payload.reflectionId)
        : reflectionBase(payload.characterId),
      method: "delete",
    });
  }

  function listDeliveries(payload: {
    characterId: string;
    page: number;
    status: string;
    pageSize?: number;
  }): Promise<DeliveryList> {
    return request<DeliveryList>({
      url: deliveryBase(payload.characterId),
      method: "get",
      params: { page: payload.page, pageSize: payload.pageSize ?? 20, status: payload.status },
    });
  }

  function getDelivery(payload: { characterId: string; deliveryId: string }): Promise<DeliveryDetail> {
    return request<DeliveryDetail>({
      url: deliveryPath(payload.characterId, payload.deliveryId),
      method: "get",
    });
  }

  function retryDelivery(payload: { characterId: string; deliveryId: string }): Promise<unknown> {
    return request<unknown>({
      url: `${deliveryPath(payload.characterId, payload.deliveryId)}/retry`,
      method: "post",
    });
  }

  function listAssessments(payload: {
    characterId: string;
    page: number;
    filter: AssessmentFilter;
    scopeId?: string;
    pageSize?: number;
  }): Promise<AssessmentPageResult> {
    return request<AssessmentPageResult>({
      url: assessmentBase(payload.characterId),
      method: "get",
      params: {
        page: payload.page,
        pageSize: payload.pageSize ?? 12,
        filter: payload.filter,
        ...(payload.scopeId ? { scopeId: payload.scopeId } : {}),
      },
    });
  }

  function listAssessmentPeople(payload: {
    characterId: string;
    page: number;
    filter: AssessmentFilter;
    pageSize?: number;
  }): Promise<AssessmentPeopleResult> {
    return request<AssessmentPeopleResult>({
      url: assessmentBase(payload.characterId),
      method: "get",
      params: { view: "people", page: payload.page, pageSize: payload.pageSize ?? 12, filter: payload.filter },
    });
  }

  function reviewAssessment(payload: {
    characterId: string;
    assessmentId: string;
    decision: AssessmentDecision;
    note: string;
  }): Promise<AssessmentReviewResult> {
    return request<AssessmentReviewResult>({
      url: `${assessmentPath(payload.characterId, payload.assessmentId)}/review`,
      method: "post",
      data: { decision: payload.decision, note: payload.note },
    });
  }

  function getOverview(payload: { characterId: string; days: number }): Promise<GrowthOverview> {
    return request<GrowthOverview>({
      url: `${characterBase(payload.characterId)}/growth/overview`,
      method: "get",
      params: { days: payload.days },
    });
  }

  function listGuidance(payload: {
    characterId: string;
    status: string;
    page: number;
    pageSize?: number;
  }): Promise<GrowthPage<GuidanceItem>> {
    return request<GrowthPage<GuidanceItem>>({
      url: guidanceBase(payload.characterId),
      method: "get",
      params: { status: payload.status, page: payload.page, pageSize: payload.pageSize ?? 20 },
    });
  }

  function updateGuidance(payload: {
    characterId: string;
    guidanceId: string;
    data: Record<string, unknown>;
  }): Promise<unknown> {
    return request<unknown>({
      url: guidancePath(payload.characterId, payload.guidanceId),
      method: "patch",
      data: payload.data,
    });
  }

  function listGuidanceHistory(payload: {
    characterId: string;
    guidanceId: string;
    page: number;
    pageSize?: number;
  }): Promise<GrowthPage<GuidanceItem>> {
    return request<GrowthPage<GuidanceItem>>({
      url: `${guidancePath(payload.characterId, payload.guidanceId)}/history`,
      method: "get",
      params: { page: payload.page, pageSize: payload.pageSize ?? 10 },
    });
  }

  function listChannelPolicies(payload: {
    characterId: string;
    status: string;
    page: number;
    pageSize?: number;
  }): Promise<GrowthPage<ChannelPolicyItem>> {
    return request<GrowthPage<ChannelPolicyItem>>({
      url: channelPolicyBase(payload.characterId),
      method: "get",
      params: { status: payload.status, page: payload.page, pageSize: payload.pageSize ?? 20 },
    });
  }

  function updateChannelPolicy(payload: {
    characterId: string;
    policyId: string;
    data: Record<string, unknown>;
  }): Promise<unknown> {
    return request<unknown>({
      url: channelPolicyPath(payload.characterId, payload.policyId),
      method: "patch",
      data: payload.data,
    });
  }

  function listChannelPolicyHistory(payload: {
    characterId: string;
    policyId: string;
    page: number;
    pageSize?: number;
  }): Promise<GrowthPage<ChannelPolicyItem>> {
    return request<GrowthPage<ChannelPolicyItem>>({
      url: `${channelPolicyPath(payload.characterId, payload.policyId)}/history`,
      method: "get",
      params: { page: payload.page, pageSize: payload.pageSize ?? 10 },
    });
  }

  return {
    listGoals,
    listGoalSources,
    suggestGoal,
    saveGoal,
    listGoalHistory,
    listGoalProgress,
    createGoalProgress,
    listPreferences,
    listPreferenceSources,
    suggestPreference,
    savePreference,
    listPreferenceHistory,
    listLanguageHabits,
    listLanguageSources,
    suggestLanguageHabit,
    selfReviewLanguageHabits,
    observeGroupLanguage,
    setAutomaticGroupLanguage,
    saveLanguageHabit,
    listLanguageHistory,
    listReflections,
    createReflection,
    retryReflection,
    reviewReflectionSuggestion,
    deleteReflection,
    listDeliveries,
    getDelivery,
    retryDelivery,
    listAssessments,
    listAssessmentPeople,
    reviewAssessment,
    getOverview,
    listGuidance,
    updateGuidance,
    listGuidanceHistory,
    listChannelPolicies,
    updateChannelPolicy,
    listChannelPolicyHistory,
  };
}

export type GrowthApi = ReturnType<typeof createGrowthApi>;
