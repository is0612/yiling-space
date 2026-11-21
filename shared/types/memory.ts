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
