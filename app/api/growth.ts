import type { ApiRequest } from "../utils/request";
// 成长域的形状与前后端共用一份（`shared/types/growth.ts`）：不再在这里手抄。
import type {
  GrowthSourceType, GrowthSource, GrowthPagination, GrowthPage,
  GoalKind, GoalStatus, GoalProgress, Goal, GoalHistory, GoalSuggestion,
  PreferenceKind, PreferenceStatus, Preference, PreferenceHistory, PreferenceSuggestion,
  ChatScope, LanguageKind, LanguageStatus, LanguageHabit, LanguageHistory, LanguageSuggestion,
} from "#shared/types/growth";
export type * from "#shared/types/growth";

// 成长域的扩展形状（反思 / 投递 / 评估 / 概览 / 指引 / 渠道策略）与后端共用。
import type {
  Assessment, AssessmentDecision, AssessmentEvidence, AssessmentFilter, AssessmentPageResult, AssessmentPeopleResult, AssessmentPersonGroup, AssessmentReviewResult, AssessmentSummary, ChannelPolicyItem, Delivery, DeliveryDetail, DeliveryList, DeliveryStatus, DeliverySummary, GuidanceItem, GuidanceKind, GuidanceStatus, GrowthOverview, GrowthOverviewConclusion, ReflectionDecision, ReflectionDeleteResult, ReflectionList, ReflectionRun, ReflectionSourceRef, ReflectionSuggestion, ReflectionSuggestionStatus,
} from "#shared/types/growth";

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
