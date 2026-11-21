import type { KnowledgeEntry, KnowledgeItemStatus } from "../../shared/types/knowledge";

/**
 * 整形前的行：`knowledge_items` 的本表标量。
 *
 * `status` 在 DB 里是 `VarChar(20)` 而不是原生枚举，所以这里收窄成契约四值是
 * **编译期断言**，运行时不校验 —— 真正的守卫在 `knowledge-lifecycle.ts` 的状态机
 * （只允许 ACTIVE/ARCHIVED/TRASHED/MERGED 之间的指定迁移）。
 */
export type KnowledgeEntryRow = {
  id: string;
  title: string;
  content: string;
  category: string;
  tags: string[];
  confidence: number | null;
  status: string;
  sourceType: string;
  sourceRef: unknown;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * 把 `knowledge_items` 的一行整形成条目 DTO（`shared/types/knowledge.ts`）。
 *
 * 之前列表接口直接 `{ ...item }`：日期是 `Date`（靠 Nitro 序列化侥幸变成 ISO），
 * `characterId` / `candidateId` 这些内部外键也跟着漏出去。这里改成显式挑字段 ——
 * 响应里有什么，读代码就能数清。
 */
export function toKnowledgeEntry(row: KnowledgeEntryRow): KnowledgeEntry {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    category: row.category,
    tags: row.tags,
    confidence: row.confidence,
    status: row.status as KnowledgeItemStatus,
    sourceType: row.sourceType,
    sourceRef: row.sourceRef,
    revision: row.revision,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
