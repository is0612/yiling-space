import type { ApiRequest } from "../utils/request";

export type KnowledgeTopicStatus = "ACTIVE" | "ARCHIVED" | "MERGED";
export type KnowledgeTopicSummary = {
  id: string; name: string; description: string; status: KnowledgeTopicStatus; revision: number;
  mergedIntoId: string | null; mergedAt: string | null; createdAt: string; updatedAt: string; memberCount: number;
};
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
  members: Array<{ itemId: string; itemRevision: number; item: KnowledgeTopicMember["item"] }>;
};
export type KnowledgeTopicPage = {
  topics: KnowledgeTopicSummary[];
  pagination: { page: number; pageSize: number; total: number; pageCount: number };
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
  function getRevision(payload: { characterId: string; topicId: string; revision: number }): Promise<{ revision: KnowledgeTopicRevisionDetail }> {
    return request({ url: `${topicPath(payload.characterId, payload.topicId)}/revisions/${payload.revision}`, method: "get" });
  }
  function restoreRevision(payload: { characterId: string; topicId: string; revision: number; expectedRevision: number }): Promise<unknown> {
    return request({ url: `${topicPath(payload.characterId, payload.topicId)}/revisions/${payload.revision}/restore`, method: "post", data: { expectedRevision: payload.expectedRevision } });
  }
  return { list, get, create, update, addMembers, removeMember, listRevisions, getRevision, restoreRevision };
}

export type KnowledgeTopicsApi = ReturnType<typeof createKnowledgeTopicsApi>;
