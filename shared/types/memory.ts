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
