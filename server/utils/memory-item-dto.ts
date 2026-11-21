import type { MemoryCategory, MemoryItem, MemoryScopeType, MemoryStatus } from "../../shared/types/memory";

/**
 * 整形前的行：`memoryScope.scopeType` 是唯一需要拍平的关联字段，
 * 其余都是本表标量。日期仍是 `Date`（Prisma 返回的就是 Date）。
 */
export type MemoryItemRow = {
  id: string;
  category: MemoryCategory;
  content: string;
  status: MemoryStatus;
  importance: number;
  validTo: Date | null;
  createdAt: Date;
  updatedAt: Date;
  memoryScope: { scopeType: MemoryScopeType };
};

/**
 * 把 `memory_items` 的一行整形成列表 DTO（`shared/types/memory.ts` 的 `MemoryItem`）。
 *
 * 列表与创建两个接口共用这一份，避免「新建出来的那条」和「列表里的那条」字段不一样：
 * 之前创建接口只回 id/category/content/status/createdAt/updatedAt，没有 importance /
 * validTo / scopeType，日期还是 Date —— 前端拿到这条直接进列表就会缺字段。
 *
 * 这里显式挑字段而不是 `...row`：`memoryScopeId` / `confidence` / `recallCount` /
 * `dedupeKey` 这些内部字段不该出现在响应里。
 */
export function toMemoryItem(row: MemoryItemRow): MemoryItem {
  return {
    id: row.id,
    category: row.category,
    content: row.content,
    status: row.status,
    scopeType: row.memoryScope.scopeType,
    importance: row.importance,
    validTo: row.validTo ? row.validTo.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
