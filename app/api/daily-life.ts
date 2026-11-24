import type { ApiRequest } from "../utils/request";

export type DailyLifePlanItem = {
  id: string;
  title: string;
  detail: string;
  plannedStartAt: string | null;
  plannedEndAt: string | null;
  place: string | null;
  scene: string;
  outfitDescription: string;
  propsDescription: string;
  status: "PLANNED" | "COMPLETED" | "CANCELLED" | "SKIPPED" | "CHANGED";
  sortOrder: number;
};
export type DailyLifePlan = {
  id: string;
  dayKey: string;
  timeZone: string;
  lifeType: string;
  summary: string;
  items: DailyLifePlanItem[];
};
export type DailyLifeActivity = {
  id: string;
  title: string;
  detail: string;
  place: string | null;
  source: "PLAN" | "USER_CONFIRMED" | "CHARACTER_INITIATED";
  status: "IN_PROGRESS" | "COMPLETED";
  startedAt: string;
  completedAt: string | null;
  planItemId: string | null;
};
export type DailyPhoto = {
  id: string;
  activityId: string | null;
  trigger: "USER_REQUESTED" | "CHARACTER_INITIATED" | "LIFE_CONTEXT" | "MEMORY_REVISIT";
  status: "GENERATED" | "GENERATION_FAILED" | "DELIVERY_PENDING" | "DELIVERED" | "DELIVERY_FAILED";
  prompt: string;
  provider: string;
  model: string;
  generationMode: string;
  relativePath: string | null;
  mime: string | null;
  caption: string;
  generatedAt: string;
  deliveredAt: string | null;
};
export type DailyLifeOverview = {
  dayKey: string;
  plan: (DailyLifePlan & { items: DailyLifePlanItem[] }) | null;
  currentActivity: DailyLifeActivity | null;
  recentActivities: DailyLifeActivity[];
  photos: DailyPhoto[];
};

const base = (characterId: string) => `/characters/${encodeURIComponent(characterId)}/daily-life`;

export function createDailyLifeApi(request: ApiRequest) {
  function getOverview(characterId: string, date: string): Promise<DailyLifeOverview> {
    return request<DailyLifeOverview>({ url: base(characterId), method: "get", params: { date } });
  }
  function createPlan(characterId: string, data: {
    dayKey: string; timeZone: string; lifeType: string; summary: string;
    items: Array<{ title: string; detail?: string; plannedStartAt?: string | null; plannedEndAt?: string | null; place?: string; scene?: string; outfitDescription?: string; propsDescription?: string }>;
  }): Promise<{ plan: DailyLifePlan }> {
    return request<{ plan: DailyLifePlan }>({ url: `${base(characterId)}/plans`, method: "post", data });
  }
  function startActivity(characterId: string, data: { planItemId?: string; title?: string; detail?: string; place?: string; source?: "USER_CONFIRMED" | "CHARACTER_INITIATED" | "PLAN"; sourceRef?: string }): Promise<{ activity: DailyLifeActivity }> {
    return request<{ activity: DailyLifeActivity }>({ url: `${base(characterId)}/activities`, method: "post", data });
  }
  function completeActivity(characterId: string, activityId: string): Promise<{ activity: DailyLifeActivity }> {
    return request<{ activity: DailyLifeActivity }>({ url: `${base(characterId)}/activities/${encodeURIComponent(activityId)}/complete`, method: "post" });
  }
  function associatePhoto(characterId: string, photoId: string, activityId: string | null): Promise<{ photo: DailyPhoto; unchanged: boolean }> {
    return request<{ photo: DailyPhoto; unchanged: boolean }>({ url: `${base(characterId)}/photos/${encodeURIComponent(photoId)}/associate`, method: "post", data: { activityId } });
  }
  return { getOverview, createPlan, startActivity, completeActivity, associatePhoto };
}
