import type { ApiRequest } from "../utils/request";

// 知识条目与候选的形状都与后端共用（`shared/types/knowledge.ts`）；这里只保留组合类型。
import type { KnowledgeCandidate, KnowledgeEntry, KnowledgeItem, KnowledgePagination, KnowledgeRelatedItem, KnowledgeRelationView } from "#shared/types/knowledge";
export type {
  KNOWLEDGE_RECOMMENDATIONS,
  KnowledgeCandidate,
  KnowledgeEntry,
  KnowledgeItem,
  KnowledgeItemRevision,
  KnowledgeItemStatus,
  KnowledgePagination,
  KnowledgeRecommendation,
  KnowledgeRelatedItem,
  KnowledgeRelationView,
  KnowledgeResult,
} from "#shared/types/knowledge";

/** 历史名字，页面里都写 `Candidate`；指向契约里的 `KnowledgeCandidate`。 */
export type Candidate = KnowledgeCandidate;

export type WorkspaceData = { candidates: Candidate[]; items: KnowledgeItem[]; candidateCount: number; itemCount: number };

export type KnowledgeArchivePage = { items: KnowledgeEntry[]; itemPagination: KnowledgePagination };

export type KnowledgeTrashPage = { items: KnowledgeEntry[]; pagination: KnowledgePagination };

export type KnowledgeLifecycleAction = "archive" | "unarchive" | "trash" | "restore";

export type KnowledgeRelationDecision = "CONFIRM_CONFLICT" | "NEEDS_VERIFICATION" | "KEEP_SEPARATE" | "DISMISS";

export type UpdateKnowledgeItemReq = {
  characterId: string;
  itemId: string;
  revision: number;
  title: string;
  content: string;
  category: string;
  tags: string[];
  confidence: number | null;
};

export type MergeKnowledgeItemsReq = {
  characterId: string;
  sourceItemId: string;
  targetItemId: string;
  expectedSourceRevision: number;
  expectedTargetRevision: number;
  title: string;
  content: string;
  category: string;
  tags: string[];
  confidence: number | null;
};

const base = (characterId: string) => `/characters/${encodeURIComponent(characterId)}/growth/knowledge`;
const itemPath = (characterId: string, itemId: string) =>
  `${base(characterId)}/items/${encodeURIComponent(itemId)}`;
const candidatePath = (characterId: string, candidateId: string) =>
  `${base(characterId)}/candidates/${encodeURIComponent(candidateId)}`;

/**
 * 成长知识库接口。
 *
 * 只拼路径、声明出入参；分页、过滤、竞态序号和提示文案留在页面里。
 * 文件导入需要 multipart，当前统一入口只支持 JSON，仍由页面单独发送。
 */
export function createKnowledgeApi(request: ApiRequest) {
  function getWorkspace(payload: { characterId: string; keyword?: string }): Promise<WorkspaceData> {
    return request<WorkspaceData>({
      url: base(payload.characterId),
      method: "get",
      ...(payload.keyword ? { params: { q: payload.keyword } } : {}),
    });
  }

  function listArchived(payload: { characterId: string; keyword?: string; page: number }): Promise<KnowledgeArchivePage> {
    return request<KnowledgeArchivePage>({
      url: base(payload.characterId),
      method: "get",
      params: {
        itemStatus: "ARCHIVED",
        ...(payload.keyword ? { q: payload.keyword } : {}),
        page: payload.page,
      },
    });
  }

  function listTrash(payload: { characterId: string; keyword?: string; page: number }): Promise<KnowledgeTrashPage> {
    return request<KnowledgeTrashPage>({
      url: `${base(payload.characterId)}/trash`,
      method: "get",
      params: {
        ...(payload.keyword ? { q: payload.keyword } : {}),
        page: payload.page,
      },
    });
  }

  function createCandidate(payload: { characterId: string; rawContent: string }): Promise<unknown> {
    return request<unknown>({
      url: `${base(payload.characterId)}/candidates`,
      method: "post",
      data: { rawContent: payload.rawContent, sourceType: "MANUAL" },
    });
  }

  function importWebCandidate(payload: { characterId: string; url: string }): Promise<unknown> {
    return request<unknown>({
      url: `${base(payload.characterId)}/candidates/web-import`,
      method: "post",
      data: { url: payload.url },
    });
  }

  function processCandidate(payload: { characterId: string; candidateId: string }): Promise<{
    candidate: Pick<Candidate, "status" | "processedResult" | "processedAt">;
  }> {
    return request<{ candidate: Pick<Candidate, "status" | "processedResult" | "processedAt"> }>({
      url: `${candidatePath(payload.characterId, payload.candidateId)}/process`,
      method: "post",
    });
  }

  function acceptCandidate(payload: { characterId: string; candidateId: string }): Promise<unknown> {
    return request<unknown>({
      url: `${candidatePath(payload.characterId, payload.candidateId)}/accept`,
      method: "post",
    });
  }

  function confirmCandidateRelation(payload: {
    characterId: string;
    candidateId: string;
    targetItemId: string;
    confirmed: boolean;
  }): Promise<unknown> {
    return request<unknown>({
      url: `${candidatePath(payload.characterId, payload.candidateId)}/relations`,
      method: "post",
      data: { targetItemId: payload.targetItemId, confirmed: payload.confirmed },
    });
  }

  function dismissCandidate(payload: { characterId: string; candidateId: string }): Promise<unknown> {
    return request<unknown>({
      url: `${candidatePath(payload.characterId, payload.candidateId)}/dismiss`,
      method: "post",
    });
  }

  function deleteCandidate(payload: { characterId: string; candidateId: string }): Promise<{ knowledgeItemRetained?: boolean }> {
    return request<{ knowledgeItemRetained?: boolean }>({
      url: candidatePath(payload.characterId, payload.candidateId),
      method: "delete",
    });
  }

  function purgeDismissedCandidates(payload: { characterId: string }): Promise<{ deletedCount: number }> {
    return request<{ deletedCount: number }>({
      url: `${base(payload.characterId)}/candidates/purge-dismissed`,
      method: "post",
      data: {},
    });
  }

  function changeItemLifecycle(payload: {
    characterId: string;
    itemId: string;
    action: KnowledgeLifecycleAction;
    expectedRevision: number;
  }): Promise<{ item: { revision: number }; message?: string }> {
    return request<{ item: { revision: number }; message?: string }>({
      url: `${itemPath(payload.characterId, payload.itemId)}/${payload.action}`,
      method: "post",
      data: { expectedRevision: payload.expectedRevision },
    });
  }

  function deleteItemPermanently(payload: {
    characterId: string;
    itemId: string;
    expectedRevision: number;
    confirm: string;
  }): Promise<{ message?: string }> {
    return request<{ message?: string }>({
      url: itemPath(payload.characterId, payload.itemId),
      method: "delete",
      data: { expectedRevision: payload.expectedRevision, confirm: payload.confirm },
    });
  }

  function updateItem(payload: UpdateKnowledgeItemReq): Promise<{ item: KnowledgeItem; unchanged: boolean }> {
    return request<{ item: KnowledgeItem; unchanged: boolean }>({
      url: itemPath(payload.characterId, payload.itemId),
      method: "patch",
      data: {
        revision: payload.revision,
        title: payload.title,
        content: payload.content,
        category: payload.category,
        tags: payload.tags,
        confidence: payload.confidence,
      },
    });
  }

  function listItemHistory(payload: { characterId: string; itemId: string }): Promise<{ revisions: KnowledgeItemRevision[] }> {
    return request<{ revisions: KnowledgeItemRevision[] }>({
      url: `${itemPath(payload.characterId, payload.itemId)}/history`,
      method: "get",
    });
  }

  function mergeItems(payload: MergeKnowledgeItemsReq): Promise<unknown> {
    return request<unknown>({
      url: `${itemPath(payload.characterId, payload.sourceItemId)}/merge`,
      method: "post",
      data: {
        targetItemId: payload.targetItemId,
        expectedSourceRevision: payload.expectedSourceRevision,
        expectedTargetRevision: payload.expectedTargetRevision,
        title: payload.title,
        content: payload.content,
        category: payload.category,
        tags: payload.tags,
        confidence: payload.confidence,
      },
    });
  }

  function resolveRelation(payload: {
    characterId: string;
    relationId: string;
    action: KnowledgeRelationDecision;
    expectedSourceRevision: number;
    expectedTargetRevision: number;
  }): Promise<unknown> {
    return request<unknown>({
      url: `${base(payload.characterId)}/relations/${encodeURIComponent(payload.relationId)}/resolve`,
      method: "post",
      data: {
        action: payload.action,
        expectedSourceRevision: payload.expectedSourceRevision,
        expectedTargetRevision: payload.expectedTargetRevision,
      },
    });
  }

  return {
    getWorkspace,
    listArchived,
    listTrash,
    createCandidate,
    importWebCandidate,
    processCandidate,
    acceptCandidate,
    confirmCandidateRelation,
    dismissCandidate,
    deleteCandidate,
    purgeDismissedCandidates,
    changeItemLifecycle,
    deleteItemPermanently,
    updateItem,
    listItemHistory,
    mergeItems,
    resolveRelation,
  };
}

export type KnowledgeApi = ReturnType<typeof createKnowledgeApi>;
