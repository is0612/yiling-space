import type { ApiRequest } from "../utils/request";

// 话题主体的形状与后端共用（`shared/types/knowledge.ts`）。
import type { KnowledgeTopicStatus, KnowledgeTopicSummary } from "#shared/types/knowledge";
export type { KnowledgeTopicPage, KnowledgeTopicStatus, KnowledgeTopicSummary } from "#shared/types/knowledge";

export type KnowledgeTopicMember = {
  id: string; itemId: string; itemRevision: number; createdAt: string; valid: boolean;
  itemRevisionChanged: boolean; invalidReason: string | null;
  item: { id: string; title: string; content: string; category: string; tags: string[]; status: string; revision: number; updatedAt: string } | null;
};
export type KnowledgeTopicRevision = {
  id: string; revision: number; name: string; description: string; status: KnowledgeTopicStatus;
  mergedIntoId: string | null; createdAt: string; memberCount?: number;
};
export type KnowledgeTopicDetail = KnowledgeTopicSummary & {
  members: KnowledgeTopicMember[];
  revisions: KnowledgeTopicRevision[];
  mergedInto: { id: string; name: string; status: string } | null;
};
export type KnowledgeTopicRevisionDetail = KnowledgeTopicRevision & {
  members: Array<{ itemId: string; itemRevision: number }>;
};

export type KnowledgeTopicRunStatus = "QUEUED" | "PROCESSING" | "READY" | "FAILED" | "STALE";
export type KnowledgeTopicSuggestionStatus = "PENDING" | "ACCEPTED" | "DISMISSED";
export type KnowledgeTopicRunSummary = {
  id: string; status: KnowledgeTopicRunStatus; attemptCount: number; maxAttempts: number;
  lastError: string | null; createdAt: string; updatedAt: string; completedAt: string | null;
  runAt: string; inputCount: number; ungroupedCount: number; suggestionCount: number;
};
export type KnowledgeTopicRunDetail = {
  id: string; status: KnowledgeTopicRunStatus; attemptCount: number; maxAttempts: number;
  lastError: string | null; createdAt: string; updatedAt: string; completedAt: string | null; runAt: string;
  inputSnapshot: Array<{ itemId: string; revision: number; item: { id: string; title: string; category: string; status: string; revision: number; updatedAt: string } | null }>;
  ungroupedItems: Array<{ id: string; title: string; category: string; status: string; revision: number; updatedAt: string }>;
  suggestions: Array<{
    id: string; name: string; description: string; reason: string; memberItemIds: string[];
    acceptedMemberItemIds: string[] | null; status: KnowledgeTopicSuggestionStatus; reviewedAt: string | null; createdAt: string;
    members: Array<{ itemId: string; item: { id: string; title: string; category: string; status: string; revision: number; updatedAt: string } | null }>;
    acceptedMembers: Array<{ itemId: string; item: { id: string; title: string; category: string; status: string; revision: number; updatedAt: string } | null }>;
  }>;
};
const base = (characterId: string) => `/characters/${encodeURIComponent(characterId)}/growth/knowledge/topics`;
const topicPath = (characterId: string, topicId: string) => `${base(characterId)}/${encodeURIComponent(topicId)}`;

export function createKnowledgeTopicsApi(request: ApiRequest) {
  function list(payload: { characterId: string; status?: KnowledgeTopicStatus; q?: string; page?: number }): Promise<KnowledgeTopicPage> {
    return request<KnowledgeTopicPage>({
      url: base(payload.characterId), method: "get",
      params: { status: payload.status ?? "ACTIVE", page: payload.page ?? 1, pageSize: 50, ...(payload.q ? { q: payload.q } : {}) },
    });
  }
  function get(payload: { characterId: string; topicId: string }): Promise<{ topic: KnowledgeTopicDetail }> {
    return request({ url: topicPath(payload.characterId, payload.topicId), method: "get" });
  }
  function create(payload: { characterId: string; name: string; description: string }): Promise<{ topic: KnowledgeTopicSummary }> {
    return request({ url: base(payload.characterId), method: "post", data: { name: payload.name, description: payload.description } });
  }
  function update(payload: { characterId: string; topicId: string; name: string; description: string; revision: number; status?: "ACTIVE" | "ARCHIVED" }): Promise<{ topic: KnowledgeTopicSummary }> {
    return request({ url: topicPath(payload.characterId, payload.topicId), method: "patch", data: { name: payload.name, description: payload.description, revision: payload.revision, ...(payload.status ? { status: payload.status } : {}) } });
  }
  function addMembers(payload: { characterId: string; topicId: string; itemIds: string[]; revision: number }): Promise<unknown> {
    return request({ url: `${topicPath(payload.characterId, payload.topicId)}/members`, method: "post", data: { itemIds: payload.itemIds, revision: payload.revision } });
  }
  function removeMember(payload: { characterId: string; topicId: string; itemId: string; revision: number }): Promise<unknown> {
    return request({ url: `${topicPath(payload.characterId, payload.topicId)}/members/${encodeURIComponent(payload.itemId)}`, method: "delete", data: { revision: payload.revision } });
  }
  function listRevisions(payload: { characterId: string; topicId: string }): Promise<{ topicId: string; currentRevision: number; revisions: KnowledgeTopicRevision[] }> {
    return request({ url: `${topicPath(payload.characterId, payload.topicId)}/revisions`, method: "get" });
  }
  function getRevision(payload: { characterId: string; topicId: string; revision: number }): Promise<{ topicId: string; currentRevision: number; snapshot: KnowledgeTopicRevisionDetail }> {
    return request({ url: `${topicPath(payload.characterId, payload.topicId)}/revisions/${payload.revision}`, method: "get" });
  }
  function restoreRevision(payload: { characterId: string; topicId: string; revision: number; expectedRevision: number }): Promise<unknown> {
    return request({ url: `${topicPath(payload.characterId, payload.topicId)}/revisions/${payload.revision}/restore`, method: "post", data: { expectedRevision: payload.expectedRevision } });
  }

  function split(payload: { characterId: string; topicId: string; name: string; description?: string; memberItemIds: string[]; revision: number }): Promise<{ sourceTopic: { id: string; name: string; description: string; status: KnowledgeTopicStatus; revision: number; updatedAt: string }; newTopic: { id: string; name: string; description: string; status: KnowledgeTopicStatus; revision: number; createdAt: string; updatedAt: string }; movedItemIds: string[]; remainingItemIds: string[] }> {
    return request({ url: `${topicPath(payload.characterId, payload.topicId)}/split`, method: "post", data: { name: payload.name, description: payload.description ?? "", memberItemIds: payload.memberItemIds, revision: payload.revision } });
  }
  function merge(payload: { characterId: string; sourceTopicId: string; targetTopicId: string; sourceRevision: number; targetRevision: number }): Promise<{ sourceTopic: { id: string; status: KnowledgeTopicStatus; revision: number; mergedIntoId: string }; targetTopic: { id: string; name: string; status: KnowledgeTopicStatus; revision: number }; addedItemIds: string[]; alreadyPresentItemIds: string[] }> {
    return request({ url: `${topicPath(payload.characterId, payload.sourceTopicId)}/merge`, method: "post", data: { targetTopicId: payload.targetTopicId, sourceRevision: payload.sourceRevision, targetRevision: payload.targetRevision } });
  }

  function createRun(payload: { characterId: string; itemIds: string[] }): Promise<{ run: { id: string; status: KnowledgeTopicRunStatus; createdAt: string } }> {
    return request({ url: `${base(payload.characterId)}/runs`, method: "post", data: { itemIds: payload.itemIds } });
  }
  function listRuns(payload: { characterId: string; status?: KnowledgeTopicRunStatus; page?: number }): Promise<{ runs: KnowledgeTopicRunSummary[]; pagination: { page: number; pageSize: number; total: number; pageCount: number } }> {
    return request({ url: `${base(payload.characterId)}/runs`, method: "get", params: { page: payload.page ?? 1, pageSize: 20, ...(payload.status ? { status: payload.status } : {}) } });
  }
  function getRun(payload: { characterId: string; runId: string }): Promise<{ run: KnowledgeTopicRunDetail }> {
    return request({ url: `${base(payload.characterId)}/runs/${encodeURIComponent(payload.runId)}`, method: "get" });
  }
  function acceptSuggestion(payload: { characterId: string; suggestionId: string; mode: "CREATE" | "APPLY"; topicId?: string; memberItemIds?: string[] }): Promise<{ topic: KnowledgeTopicSummary; acceptedMemberItemIds: string[] }> {
    return request({ url: `${base(payload.characterId)}/suggestions/${encodeURIComponent(payload.suggestionId)}/accept`, method: "post", data: { mode: payload.mode, ...(payload.topicId ? { topicId: payload.topicId } : {}), ...(payload.memberItemIds ? { memberItemIds: payload.memberItemIds } : {}) } });
  }
  function dismissSuggestion(payload: { characterId: string; suggestionId: string }): Promise<{ id: string; status: "DISMISSED" }> {
    return request({ url: `${base(payload.characterId)}/suggestions/${encodeURIComponent(payload.suggestionId)}/dismiss`, method: "post" });
  }
  return { list, get, create, update, addMembers, removeMember, listRevisions, getRevision, restoreRevision, split, merge, createRun, listRuns, getRun, acceptSuggestion, dismissSuggestion };
}

export type KnowledgeTopicsApi = ReturnType<typeof createKnowledgeTopicsApi>;
