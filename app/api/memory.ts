import type { ApiRequest } from "../utils/request";
import type { Character, Snapshot, SnapshotDetail, SnapshotSourceMessage } from "../utils/mock-data";
import type { MemoryProgressRow } from "../composables/useMemoryProgress";
// 记忆条目的形状与枚举与后端共用一份（`shared/types/memory.ts`）；页面沿用 `MemoryRow` 这个名字。
import type {
  GroupChatPayload, InteractionExperienceItem, InteractionExperiencePage, MemoryCategory, MemoryDayDetail, MemoryDayMessages,
  MemoryDayPage, MemoryDetail, MemoryEvent, MemoryEventDuplicatePayload, MemoryEventKnowledgeResult,
  MemoryExtractResult, MemoryExtractionPreview, MemoryItem, MemoryPage, MemoryStats,
  PrivateChatCursor, PrivateChatPayload, RecycleBinPage, SnapshotGenerateResult,
  StaleMemoryApplyResult, StaleMemoryAuditResult, StaleMemoryKind,
} from "#shared/types/memory";
import type { SnapshotPage } from "#shared/types/snapshot";
export type {
  MEMORY_CATEGORIES, MEMORY_STATUSES, MEMORY_SCOPE_TYPES,
  MEMORY_EVENT_STATES, MEMORY_EVENT_STATUSES, MEMORY_EVENT_SCOPES,
  MemoryCategory, MemoryEvent, MemoryEventScope, MemoryEventState, MemoryEventStatus,
  GroupChatGroup, GroupChatMessage, GroupChatPayload, PrivateChatChat, PrivateChatMessage, PrivateChatPayload, PrivateChatCursor,
  MemoryDayDetail, MemoryDayMessage, MemoryDayMessageGroup, MemoryDayMessages, MemoryDayPage, MemoryDayRow,
  MemoryItem, MemoryPage, StaleMemoryAuditResult, StaleMemoryItem,
} from "#shared/types/memory";
export type MemoryRow = MemoryItem;



/** 忆泡：与后端共用同一份契约（`shared/types/memory.ts` 的 `MemoryEvent`）。 */
export type MemoryDayEvent = MemoryEvent;

export type MemoryProgressPayload = {
  jobs: MemoryProgressRow[];
  checkedAt: string;
};


// 分页形状与后端共用（`shared/types/snapshot.ts`）。
export type { SnapshotPage, SnapshotSourcePage } from "#shared/types/snapshot";



const characterBase = (characterId: string) => `/characters/${encodeURIComponent(characterId)}`;
const memoryPath = (memoryId: string) => `/memories/${encodeURIComponent(memoryId)}`;
const eventBase = (characterId: string) => `${characterBase(characterId)}/memory-events`;
const snapshotBase = (characterId: string) => `${characterBase(characterId)}/snapshots`;
const interactionBase = (characterId: string) => `${characterBase(characterId)}/growth/interaction-experiences`;

/**
 * 记忆模块接口。
 *
 * 只拼路径、声明出入参；分页、筛选、竞态序号、乐观版本与提示文案留在页面里。
 * `useMemoryProgress` 的轮询仍直接用 `$fetch`：它只跑在客户端，且需要自己持有 AbortController。
 */
export function createMemoryApi(request: ApiRequest) {
  function getCharacter(characterId: string): Promise<Character> {
    return request<Character>({ url: characterBase(characterId), method: "get" });
  }

  function listMemories(payload: {
    characterId: string;
    page: number;
    pageSize: number;
    keyword?: string;
    scope?: string;
    category?: string;
    status?: string;
  }): Promise<MemoryPage> {
    return request<MemoryPage>({
      url: `${characterBase(payload.characterId)}/memories`,
      method: "get",
      params: {
        page: payload.page,
        pageSize: payload.pageSize,
        ...(payload.keyword ? { q: payload.keyword } : {}),
        ...(payload.scope ? { scope: payload.scope } : {}),
        ...(payload.category ? { category: payload.category } : {}),
        ...(payload.status ? { status: payload.status } : {}),
      },
    });
  }

  function getMemoryStats(characterId: string): Promise<MemoryStats> {
    return request<MemoryStats>({ url: `${characterBase(characterId)}/memory-stats`, method: "get" });
  }

  function createMemory(payload: {
    characterId: string;
    category: MemoryCategory;
    content: string;
    scope: "character" | "private";
  }): Promise<unknown> {
    return request<unknown>({
      url: `${characterBase(payload.characterId)}/memories`,
      method: "post",
      data: { category: payload.category, content: payload.content, scope: payload.scope },
    });
  }

  function getMemory(memoryId: string): Promise<MemoryDetail> {
    return request<MemoryDetail>({ url: memoryPath(memoryId), method: "get" });
  }

  function updateMemory(payload: { memoryId: string; category: MemoryCategory; content: string }): Promise<unknown> {
    return request<unknown>({
      url: memoryPath(payload.memoryId),
      method: "patch",
      data: { category: payload.category, content: payload.content },
    });
  }

  function changeMemoryStatus(payload: { memoryId: string; status: string }): Promise<unknown> {
    return request<unknown>({
      url: memoryPath(payload.memoryId),
      method: "patch",
      data: { status: payload.status },
    });
  }

  function listTrashedMemories(payload: { characterId: string; page: number; pageSize: number }): Promise<RecycleBinPage> {
    return request<RecycleBinPage>({
      url: `${characterBase(payload.characterId)}/memories/trash`,
      method: "get",
      params: { page: payload.page, pageSize: payload.pageSize },
    });
  }

  function trashMemory(memoryId: string): Promise<unknown> {
    return request<unknown>({ url: `${memoryPath(memoryId)}/trash`, method: "post" });
  }

  function restoreMemory(memoryId: string): Promise<unknown> {
    return request<unknown>({ url: `${memoryPath(memoryId)}/restore`, method: "post" });
  }

  function deleteMemory(memoryId: string): Promise<{ preservedSnapshotReferences: number }> {
    return request<{ preservedSnapshotReferences: number }>({ url: memoryPath(memoryId), method: "delete" });
  }

  function clearTrashedMemories(characterId: string): Promise<{ deleted: number; preservedSnapshotReferences: number }> {
    return request<{ deleted: number; preservedSnapshotReferences: number }>({
      url: `${characterBase(characterId)}/memories/trash`,
      method: "delete",
    });
  }

  function importConversation(payload: {
    characterId: string;
    title: string;
    messages: Array<{ role: "USER" | "ASSISTANT"; content: string }>;
  }): Promise<{ messageCount: number; timestampsEstimated: boolean }> {
    return request<{ messageCount: number; timestampsEstimated: boolean }>({
      url: `${characterBase(payload.characterId)}/conversations/import`,
      method: "post",
      data: { title: payload.title, messages: payload.messages },
    });
  }

  function listGroupChats(payload: { characterId: string; conversationId?: string }): Promise<GroupChatPayload> {
    return request<GroupChatPayload>({
      url: `${characterBase(payload.characterId)}/group-chats`,
      method: "get",
      ...(payload.conversationId ? { params: { conversationId: payload.conversationId } } : {}),
    });
  }

  function listPrivateChats(payload: {
    characterId: string;
    conversationId?: string;
    cursor?: PrivateChatCursor;
  }): Promise<PrivateChatPayload> {
    return request<PrivateChatPayload>({
      url: `${characterBase(payload.characterId)}/private-chats`,
      method: "get",
      params: {
        ...(payload.conversationId ? { conversationId: payload.conversationId } : {}),
        ...(payload.cursor ? { before: payload.cursor.before, beforeId: payload.cursor.beforeId } : {}),
      },
    });
  }

  function listDays(payload: {
    characterId: string;
    page: number;
    pageSize: number;
    /** 日历按月取数：给了区间就不分页，返回区间内每一天（含没有记录的日子）。 */
    from?: string;
    to?: string;
    keyword?: string;
  }): Promise<MemoryDayPage> {
    return request<MemoryDayPage>({
      url: `${characterBase(payload.characterId)}/days`,
      method: "get",
      params: {
        page: payload.page,
        pageSize: payload.pageSize,
        ...(payload.keyword ? { q: payload.keyword } : {}),
        ...(payload.from && payload.to ? { from: payload.from, to: payload.to } : {}),
      },
    });
  }

  function getDayDetail(payload: { characterId: string; dayKey: string; page: number }): Promise<MemoryDayDetail> {
    return request<MemoryDayDetail>({
      url: `${characterBase(payload.characterId)}/days/${encodeURIComponent(payload.dayKey)}`,
      method: "get",
      params: { page: payload.page },
    });
  }

  function listDayMessages(payload: { characterId: string; dayKey: string }): Promise<MemoryDayMessages> {
    return request<MemoryDayMessages>({
      url: `${characterBase(payload.characterId)}/days/${encodeURIComponent(payload.dayKey)}/messages`,
      method: "get",
    });
  }

  function updateMemoryEvent(payload: {
    characterId: string;
    eventId: string;
    title: string;
    detail: string;
    place: string;
    participants: string[];
  }): Promise<unknown> {
    return request<unknown>({
      url: `${eventBase(payload.characterId)}/${encodeURIComponent(payload.eventId)}`,
      method: "patch",
      data: {
        title: payload.title,
        detail: payload.detail,
        place: payload.place,
        participants: payload.participants,
      },
    });
  }

  function changeMemoryEventStatus(payload: {
    characterId: string;
    eventId: string;
    status: "ACTIVE" | "ARCHIVED";
  }): Promise<unknown> {
    return request<unknown>({
      url: `${eventBase(payload.characterId)}/${encodeURIComponent(payload.eventId)}`,
      method: "patch",
      data: { status: payload.status },
    });
  }

  function requestEventKnowledge(payload: {
    characterId: string;
    eventId: string;
    excerpt: string;
    reason: string;
  }): Promise<MemoryEventKnowledgeResult> {
    return request<MemoryEventKnowledgeResult>({
      url: `${eventBase(payload.characterId)}/${encodeURIComponent(payload.eventId)}/knowledge-candidate`,
      method: "post",
      data: { excerpt: payload.excerpt, reason: payload.reason },
    });
  }

  function previewMemoryEvents(characterId: string): Promise<MemoryExtractionPreview> {
    return request<MemoryExtractionPreview>({
      url: `${eventBase(characterId)}/preview`,
      method: "get",
    });
  }

  function deletePendingMemoryEvents(characterId: string, body: { key: string; expectedCount: number; checkedAt: string }): Promise<{ deletedMessages: number }> {
    return request<{ deletedMessages: number }>({
      url: `${eventBase(characterId)}/pending`,
      method: "delete",
      data: body,
    });
  }

  function listMemoryProgress(payload: { characterId?: string; type?: string }): Promise<MemoryProgressPayload> {
    return request<MemoryProgressPayload>({
      url: "/memory-progress",
      method: "get",
      ...(payload.characterId || payload.type
        ? {
            params: {
              ...(payload.characterId ? { characterId: payload.characterId } : {}),
              ...(payload.type ? { type: payload.type } : {}),
            },
          }
        : {}),
    });
  }

  function listMemoryEventDuplicates(payload: {
    characterId: string;
    dayKey: string;
  }): Promise<MemoryEventDuplicatePayload> {
    return request<MemoryEventDuplicatePayload>({
      url: `${eventBase(payload.characterId)}/duplicates`,
      method: "get",
      params: { dayKey: payload.dayKey },
    });
  }

  function archiveMemoryEventDuplicate(payload: {
    characterId: string;
    keepId: string;
    candidateId: string;
    token: string;
  }): Promise<unknown> {
    return request<unknown>({
      url: `${eventBase(payload.characterId)}/duplicates`,
      method: "post",
      data: { keepId: payload.keepId, candidateId: payload.candidateId, token: payload.token },
    });
  }

  function listSnapshots(payload: {
    characterId: string;
    page: number;
    pageSize: number;
    status?: string;
    kind?: "AUTOMATIC" | "MANUAL";
    keyword?: string;
  }): Promise<SnapshotPage> {
    return request<SnapshotPage>({
      url: snapshotBase(payload.characterId),
      method: "get",
      params: {
        page: payload.page,
        pageSize: payload.pageSize,
        ...(payload.status ? { status: payload.status } : {}),
        ...(payload.kind ? { kind: payload.kind } : {}),
        ...(payload.keyword ? { q: payload.keyword } : {}),
      },
    });
  }

  function getSnapshot(payload: { characterId: string; snapshotId: string }): Promise<SnapshotDetail> {
    return request<SnapshotDetail>({
      url: `${snapshotBase(payload.characterId)}/${encodeURIComponent(payload.snapshotId)}`,
      method: "get",
    });
  }

  function listSnapshotSources(payload: {
    characterId: string;
    snapshotId: string;
    page: number;
    pageSize: number;
  }): Promise<SnapshotSourcePage> {
    return request<SnapshotSourcePage>({
      url: `${snapshotBase(payload.characterId)}/${encodeURIComponent(payload.snapshotId)}/sources`,
      method: "get",
      params: { page: payload.page, pageSize: payload.pageSize },
    });
  }

  function reviewSnapshotChange(payload: {
    characterId: string;
    snapshotId: string;
    changeIndex: number;
    decision: "ACCEPT" | "IGNORE";
  }): Promise<{ outcome: string | null }> {
    return request<{ outcome: string | null }>({
      url: `${snapshotBase(payload.characterId)}/${encodeURIComponent(payload.snapshotId)}/review`,
      method: "post",
      data: { changeIndex: payload.changeIndex, decision: payload.decision },
    });
  }

  function createSnapshot(characterId: string): Promise<{ id: string }> {
    return request<{ id: string }>({ url: snapshotBase(characterId), method: "post" });
  }

  function regenerateSnapshot(payload: { characterId: string; snapshotId: string }): Promise<{ id: string }> {
    return request<{ id: string }>({
      url: snapshotBase(payload.characterId),
      method: "post",
      data: { snapshotId: payload.snapshotId },
    });
  }

  function queueSnapshotAiRegeneration(payload: {
    characterId: string;
    snapshotId: string;
  }): Promise<{ jobId: string; status: string; duplicate: boolean }> {
    return request<{ jobId: string; status: string; duplicate: boolean }>({
      url: snapshotBase(payload.characterId),
      method: "post",
      data: { snapshotId: payload.snapshotId, mode: "ai" },
    });
  }

  function generateSnapshot(characterId: string): Promise<SnapshotGenerateResult> {
    return request<SnapshotGenerateResult>({
      url: `${snapshotBase(characterId)}/generate`,
      method: "post",
    });
  }

  function extractMemoryEvents(characterId: string): Promise<MemoryExtractResult> {
    return request<MemoryExtractResult>({
      url: `${eventBase(characterId)}/extract`,
      method: "post",
    });
  }

  function listInteractionExperiences(payload: {
    characterId: string;
    status: string;
    page: number;
    pageSize: number;
  }): Promise<InteractionExperiencePage> {
    return request<InteractionExperiencePage>({
      url: interactionBase(payload.characterId),
      method: "get",
      params: { status: payload.status, page: payload.page, pageSize: payload.pageSize },
    });
  }

  function listInteractionExperienceConversations(characterId: string) {
    return request<{ conversations: Array<{ id: string; title: string | null; scene: "WEB" | "GROUP" | "PRIVATE" }> }>({
      url: `${interactionBase(characterId)}/evidence`, method: "get",
    });
  }

  function listInteractionExperienceMessages(characterId: string, conversationId: string) {
    return request<{ messages: Array<{ id: string; role: "USER" | "ASSISTANT"; content: string; occurredAt: string }> }>({
      url: `${interactionBase(characterId)}/evidence`, method: "get", params: { conversationId },
    });
  }

  function proposeInteractionExperience(characterId: string, assistantMessageId: string, feedbackMessageId: string) {
    return request<{ item: InteractionExperienceItem | null; notice: string }>({
      url: interactionBase(characterId), method: "post", data: { assistantMessageId, feedbackMessageId },
    });
  }

  function updateInteractionExperience(payload: {
    characterId: string;
    itemId: string;
    revision: number;
    operation: "EDIT" | "DISABLE" | "ACCEPT" | "REJECT";
    content?: string;
    context?: string;
    learning?: unknown;
  }): Promise<unknown> {
    return request<unknown>({
      url: `${interactionBase(payload.characterId)}/${encodeURIComponent(payload.itemId)}`,
      method: "patch",
      data: {
        revision: payload.revision,
        operation: payload.operation,
        ...(payload.operation === "EDIT" ? { content: payload.content, context: payload.context, learning: payload.learning } : {}),
      },
    });
  }

  function updateInteractionExperienceSettings(payload: {
    characterId: string;
    enabled: boolean;
  }): Promise<unknown> {
    return request<unknown>({
      url: `${interactionBase(payload.characterId)}/settings`,
      method: "patch",
      data: { enabled: payload.enabled },
    });
  }

  /**
   * 记忆体检：让模型提名已经失效的长期记忆 / 忆泡。只读，不写任何状态。
   * 结果必须由人勾选后再走 `applyStaleMemories`。
   */
  function auditStaleMemories(payload: {
    characterId: string;
    scopes?: StaleMemoryKind[];
    /** 忆泡：只查这一天。 */
    dayKey?: string;
    /** 忆泡：最近 N 天（不给 dayKey 时生效，默认 7）。 */
    rangeDays?: number;
  }): Promise<StaleMemoryAuditResult> {
    return request<StaleMemoryAuditResult>({
      url: `${characterBase(payload.characterId)}/memory-audit`,
      method: "post",
      data: {
        ...(payload.scopes ? { scopes: payload.scopes } : {}),
        ...(payload.dayKey ? { dayKey: payload.dayKey } : {}),
        ...(payload.rangeDays ? { rangeDays: payload.rangeDays } : {}),
      },
    });
  }

  function applyStaleMemories(payload: {
    characterId: string;
    items: Array<{ kind: StaleMemoryKind; id: string; fingerprint: string; reason?: string }>;
  }): Promise<StaleMemoryApplyResult> {
    return request<StaleMemoryApplyResult>({
      url: `${characterBase(payload.characterId)}/memory-audit/apply`,
      method: "post",
      data: { items: payload.items },
    });
  }

  return {
    getCharacter,
    listMemories,
    getMemoryStats,
    createMemory,
    getMemory,
    updateMemory,
    changeMemoryStatus,
    listTrashedMemories,
    trashMemory,
    restoreMemory,
    deleteMemory,
    clearTrashedMemories,
    importConversation,
    listGroupChats,
    listPrivateChats,
    listDays,
    getDayDetail,
    listDayMessages,
    updateMemoryEvent,
    changeMemoryEventStatus,
    requestEventKnowledge,
    previewMemoryEvents,
    deletePendingMemoryEvents,
    listMemoryProgress,
    listMemoryEventDuplicates,
    archiveMemoryEventDuplicate,
    auditStaleMemories,
    applyStaleMemories,
    listSnapshots,
    getSnapshot,
    listSnapshotSources,
    reviewSnapshotChange,
    createSnapshot,
    regenerateSnapshot,
    queueSnapshotAiRegeneration,
    generateSnapshot,
    extractMemoryEvents,
    listInteractionExperiences,
    listInteractionExperienceConversations,
    listInteractionExperienceMessages,
    proposeInteractionExperience,
    updateInteractionExperience,
    updateInteractionExperienceSettings,
  };
}

export type MemoryApi = ReturnType<typeof createMemoryApi>;
