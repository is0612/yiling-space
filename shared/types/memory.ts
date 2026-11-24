/**
 * 记忆域的前后端共享契约。
 *
 * 只放**会过 HTTP 边界的形状**：日期一律 `string`（JSON 传输后就是 ISO），
 * 枚举以 `as const` 数组为准、类型由数组派生，服务端校验与前端筛选共用一份。
 *
 * 与成长域不同，这里的 `category` / `status` 在 Prisma 里是原生枚举，
 * 不是裸字符串列 —— 服务端整形不需要 `as` 收窄，类型直接对得上。
 */

export const MEMORY_CATEGORIES = ["FACT", "PREFERENCE", "RELATIONSHIP", "COMMITMENT", "GOAL", "EVENT", "SUMMARY", "OTHER"] as const;
export type MemoryCategory = typeof MEMORY_CATEGORIES[number];

export const MEMORY_STATUSES = ["ACTIVE", "SUPERSEDED", "ARCHIVED", "INVALIDATED", "TRASHED"] as const;
export type MemoryStatus = typeof MEMORY_STATUSES[number];

export const MEMORY_SCOPE_TYPES = ["CHARACTER_GLOBAL", "USER_PRIVATE", "EXTERNAL_IDENTITY"] as const;
export type MemoryScopeType = typeof MEMORY_SCOPE_TYPES[number];

/**
 * 一条长期记忆在列表里的形状（`GET /characters/{id}/memories`）。
 *
 * 只带列表要显示的字段：`memoryScope.scopeType` 拍平成 `scopeType`，
 * 不把 `memoryScopeId` / `confidence` / `recallCount` 这些内部字段发出去。
 */
export type MemoryItem = {
  id: string;
  category: MemoryCategory;
  content: string;
  status: MemoryStatus;
  scopeType: MemoryScopeType;
  importance: number;
  validTo: string | null;
  createdAt: string;
  updatedAt: string;
};

export type MemoryPage = {
  items: MemoryItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

export const MEMORY_EVENT_STATES = ["DRAFT", "FINAL"] as const;
export type MemoryEventState = typeof MEMORY_EVENT_STATES[number];

export const MEMORY_EVENT_STATUSES = ["ACTIVE", "ARCHIVED"] as const;
export type MemoryEventStatus = typeof MEMORY_EVENT_STATUSES[number];

/** 范围是给页面看的语义（角色全局 / 当前用户私人 / 外部身份），不是 `scopeType` 原值。 */
export const MEMORY_EVENT_SCOPES = ["character", "private", "external"] as const;
export type MemoryEventScope = typeof MEMORY_EVENT_SCOPES[number];

/**
 * 一条忆泡（`memory_events`）。
 *
 * `dayKey` 可选：日子详情按 dayKey 取数据、不重复回传，编辑接口会带上。
 * 这是两个接口真实响应的并集 —— 不要因为「另一处没有」就把它删掉，
 * 也不要因为「这里没有」就要求那边补上。
 *
 * 时间线的条目（`toMemoryTimelineDtos`）是跨实体的联合形状，不是忆泡本身，
 * 不套用这个类型。
 */
export type MemoryEvent = {
  id: string;
  dayKey?: string;
  occurredAt: string;
  /** 模糊时段（上午/下午/深夜…）；null = 只知道日期。 */
  timeOfDay: string | null;
  place: string | null;
  participants: string[];
  title: string;
  detail: string;
  state: MemoryEventState;
  status: MemoryEventStatus;
  confidence: number | null;
  sourceMessageIds: string[];
  scope: MemoryEventScope;
};

// ── 日子（按角色时区切的一天） ────────────────────────────────

export type MemoryDayRow = {
  dayKey: string;
  /** null = 这天还没有任何整理记录（日历上仍要画出来）。 */
  state: "DRAFT" | "FINAL" | null;
  eventCount: number;
  extractedAt: string | null;
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

/**
 * 日子列表。`query` / `from` / `to` 是筛选回显：范围查询时服务端把入参原样带回，
 * 页面拿它就能把日历与搜索框填回原状，不用自己再记一份。
 */
export type MemoryDayPage = {
  today: string;
  timeZone: string;
  days: MemoryDayRow[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  query?: string;
  from?: string;
  to?: string;
};

export type MemoryDayDetail = {
  day: MemoryDayRow | null;
  events: MemoryEvent[];
  usage: { calls: number; tokens: number };
  timeZone: string;
  eventsTotal: number;
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

// ── 统计 / 详情 / 回收站 ─────────────────────────────────────

export type MemoryStats = {
  memory: number;
  commitment: number;
  message: number;
  event: number;
  snapshot: number;
  memoryEvent: number;
};

/** 单条记忆的详情：多带来源消息与来源快照两级上下文。 */
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

// ── 群聊 / 私聊视图（记忆页的取材面板） ──────────────────────────

export type GroupChatGroup = {
  conversationId: string;
  groupId: string | null;
  label: string;
  lastMessageAt: string | null;
  updatedAt: string;
  messageCount: number;
  connectionName: string | null;
  automaticObservation?: { enabled: boolean; lastError: string | null };
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

/** 私聊游标：`null` 表示已经到最早一条。 */
export type PrivateChatCursor = { before: string; beforeId: string } | null;

/**
 * 私聊取材面板：与群聊对称——给的是**会话列表** + 当前选中的那个，不是单个会话。
 *
 * 前端类型原先写成 `chat: PrivateChatChat | null`，与后端实际返回的 `chats` /
 * `selectedConversationId` 对不上；页面读的是 `chats`，所以类型是错的、运行时是对的。
 */
export type PrivateChatPayload = {
  chats: PrivateChatChat[];
  selectedConversationId: string | null;
  messages: PrivateChatMessage[];
  /** 还有更早的消息可以继续往前翻。 */
  hasMore: boolean;
  nextCursor: PrivateChatCursor;
};

// ── 提取 / 重复检测 / 进度 ────────────────────────────────────

/** 把一条忆泡转成知识候选的结果。 */
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

// ── 失效体检 ───────────────────────────────────────────────────

export type StaleMemoryKind = "MEMORY" | "EVENT";
export type StaleMemoryVerdict = "CONTRADICTED" | "OBSOLETE";

/** 一条被模型提名「可能已经失效」的记忆 / 忆泡。是否真清理由人决定。 */
export type StaleMemoryItem = {
  kind: StaleMemoryKind;
  id: string;
  /** 记忆分类或忆泡标题。 */
  title: string;
  content: string;
  /** 时间 / 重要度这类辅助判断信息。 */
  meta: string;
  fingerprint: string;
  verdict: StaleMemoryVerdict;
  reason: string;
  confidence: number;
};

export type StaleMemoryAuditResult = {
  scannedAt: string;
  counts: {
    memory: { active: number; scanned: number };
    event: { active: number; scanned: number };
  };
  items: StaleMemoryItem[];
  /** 高置信（≥90%）过期忆泡已在服务端自动归档的明细，可恢复，不再进人工列表。 */
  autoApplied: { count: number; items: StaleMemoryItem[] };
};

export type StaleMemoryApplyResult = {
  memory: number;
  event: number;
};

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

// ── 互动经验（对话里学到的相处方式） ──────────────────────────────

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
