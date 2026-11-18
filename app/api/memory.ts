import type { ApiRequest } from "../utils/request";
import type { Character, Snapshot, SnapshotDetail, SnapshotSourceMessage } from "../utils/mock-data";
import type { MemoryProgressRow } from "../composables/useMemoryProgress";

export type MemoryCategory = "FACT" | "PREFERENCE" | "RELATIONSHIP" | "COMMITMENT" | "GOAL" | "EVENT" | "SUMMARY" | "OTHER";

export type MemoryRow = {
  id: string;
  category: string;
  content: string;
  status: string;
  scopeType: string;
  importance: number;
  validTo: string | null;
  createdAt: string;
  updatedAt: string;
};

export type MemoryPage = {
  items: MemoryRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

export type MemoryStats = {
  memory: number;
  commitment: number;
  message: number;
  event: number;
  snapshot: number;
  memoryEvent: number;
};

export type MemoryDetail = {
  id: string;
  category: MemoryCategory;
  content: string;
  sourceMessageId: string | null;
  sourceSnapshotId: string | null;
  sourceMessage: {
    id: string;
    role: string;
    eventType: string;
    content: string;
    occurredAt: string;
    conversation: { id: string; title: string | null };
  } | null;
  sourceSnapshot: {
    id: string;
    summary: string;
    periodStart: string;
    periodEnd: string;
    version: number;
    status: string;
  } | null;
};

export type RecycleBinEntry = {
  id: string;
  category: MemoryCategory;
  content: string;
  statusBeforeTrash: "ACTIVE" | "SUPERSEDED" | "ARCHIVED" | "INVALIDATED" | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type RecycleBinPage = {
  items: RecycleBinEntry[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

export type GroupChatGroup = {
  conversationId: string;
  groupId: string | null;
  label: string;
  lastMessageAt: string | null;
  updatedAt: string;
  messageCount: number;
  connectionName: string | null;
};

export type GroupChatMessage = {
  id: string;
  role: string;
  content: string;
  occurredAt: string;
  author: string | null;
  member: string | null;
};

export type GroupChatPayload = {
  groups: GroupChatGroup[];
  selectedConversationId: string | null;
  messages: GroupChatMessage[];
};

export type PrivateChatChat = {
  conversationId: string;
  qq: string | null;
  label: string;
  lastMessageAt: string | null;
  updatedAt: string;
  messageCount: number;
  connectionName: string | null;
};

export type PrivateChatMessage = {
  id: string;
  role: string;
  content: string;
  occurredAt: string;
  author: string | null;
  isOwner: boolean;
};

export type PrivateChatCursor = { before: string; beforeId: string } | null;

export type PrivateChatPayload = {
  chats: PrivateChatChat[];
  selectedConversationId: string | null;
  messages: PrivateChatMessage[];
  hasMore: boolean;
  nextCursor: PrivateChatCursor;
};

export type MemoryDayRow = {
  dayKey: string;
  state: "DRAFT" | "FINAL" | null;
  eventCount: number;
  extractedAt: string | null;
};

export type MemoryDayEvent = {
  id: string;
  occurredAt: string;
  timeOfDay: string | null;
  place: string | null;
  participants: string[];
  title: string;
  detail: string;
  state: "DRAFT" | "FINAL";
  status: "ACTIVE" | "ARCHIVED";
  confidence: number | null;
  scope: "character" | "private" | "external";
};

export type MemoryDayMessage = {
  id: string;
  role: string;
  content: string;
  occurredAt: string;
  author: string | null;
  member: string | null;
};

export type MemoryDayMessageGroup = {
  id: string;
  title: string;
  total: number;
  messages: MemoryDayMessage[];
};

export type MemoryDayPage = {
  today: string;
  timeZone: string;
  days: MemoryDayRow[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

export type MemoryDayDetail = {
  day: MemoryDayRow | null;
  events: MemoryDayEvent[];
  usage: { calls: number; tokens: number };
  timeZone: string;
  eventsTotal: number;
  eventsTruncated: boolean;
  eventsPage: number;
  eventsPageSize: number;
  eventsTotalPages: number;
};

export type MemoryDayMessages = {
  dayKey: string;
  timeZone: string;
  messageGroups: MemoryDayMessageGroup[];
  totalMessages: number;
};

export type MemoryEventKnowledgeResult = {
  requestId: string;
  eventId: string | null;
  status: "PENDING" | "CREATED" | "SKIPPED";
  candidateId: string | null;
  created: boolean;
};

export type MemoryExtractionPreview = {
  characterId: string;
  characterName: string;
  timeZone: string;
  checkedAt: string;
  totalMessages: number;
  rows: Array<{ key: string; dayKey: string; conversationLabel: string; scopeLabel: string; pendingMessages: number }>;
  truncated: boolean;
  hasLegacyOwnerChats: boolean;
  notice: string | null;
};

export type MemoryProgressPayload = {
  jobs: MemoryProgressRow[];
  checkedAt: string;
};

export type MemoryEventDuplicateEntry = {
  id: string;
  title: string;
  detail: string;
  sourceMessageIds: string[];
};

export type MemoryEventDuplicatePair = {
  keep: MemoryEventDuplicateEntry;
  candidate: MemoryEventDuplicateEntry;
  reason: string;
  token: string;
};

export type MemoryEventDuplicatePayload = {
  pairs: MemoryEventDuplicatePair[];
  checkedCount: number;
  pairsLimited: boolean;
};

export type SnapshotPage = {
  items: Snapshot[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  counts: { automatic: number; manual: number; current: number; superseded: number };
  stats: { messages: number; latestDate: string | null; automatic: number; manual: number };
};

export type SnapshotSourcePage = {
  items: SnapshotSourceMessage[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

/** `snapshots/generate`：手动触发一次阶段总结。 */
export type SnapshotGenerateResult = {
  queued: string[];
  skipped: string[];
  processed: Array<{ status: string; message: string }>;
  pending: number;
  advancedTo: string | null;
  processing?: boolean;
};

/** `memory-events/extract`：整理昨天与今天的忆泡。 */
export type MemoryExtractResult = {
  queued: string[];
  processed: Array<{ status: string; message: string }>;
  notice?: "queued" | "running" | "no-new-messages";
  processing?: boolean;
};

export type InteractionExperienceItem = {
  review?: { status: string; reason: string; reviewedAt: string; revision: number; current: boolean } | null;
  id: string;
  content: string;
  context: string;
  feedbackQuote: string;
  status: string;
  revision: number;
  conversationId: string;
  weight: number;
  createdAt?: string;
  updatedAt?: string;
  learning?: unknown;
};

export type InteractionExperienceAutomation = {
  enabled: boolean;
  status: string;
  lastError: string | null;
  nextRunAt?: string | null;
  lastCompletedAt?: string | null;
};

export type InteractionExperiencePage = {
  items: InteractionExperienceItem[];
  pagination?: { page: number; pageSize: number; total: number; pageCount: number };
  automation?: InteractionExperienceAutomation;
};

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
    keyword?: string;
  }): Promise<MemoryDayPage> {
    return request<MemoryDayPage>({
      url: `${characterBase(payload.characterId)}/days`,
      method: "get",
      params: {
        page: payload.page,
        pageSize: payload.pageSize,
        ...(payload.keyword ? { q: payload.keyword } : {}),
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
    updateInteractionExperience,
    updateInteractionExperienceSettings,
  };
}

export type MemoryApi = ReturnType<typeof createMemoryApi>;
