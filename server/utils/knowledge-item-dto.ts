import type { KnowledgeEntry, KnowledgeItemRevision, KnowledgeItemStatus } from "../../shared/types/knowledge";

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

export type KnowledgeRevisionRow = {
  id: string;
  revision: number;
  title: string;
  content: string;
  category: string;
  tags: string[];
  confidence: number | null;
  status: string;
  sourceType: string;
  sourceRef: unknown;
  createdAt: Date;
};

/**
 * 历史版本（`knowledge_item_revisions` 的一行）。
 *
 * 注意：表里还有一个 `action` 列（CONTENT_EDIT / MERGE / ARCHIVE / RESTORE…），
 * 但历史接口从来没有 select 它，前端也拿不到「这一版是哪次操作造成的」。
 * 契约按真实响应定义，不含 `action` —— 要显示它得先让接口 select 出来，
 * 不是在这里凭空加一个字段。
 */
export function toKnowledgeRevision(row: KnowledgeRevisionRow): KnowledgeItemRevision {
  return {
    id: row.id,
    revision: row.revision,
    title: row.title,
    content: row.content,
    category: row.category,
    tags: row.tags,
    confidence: row.confidence,
    status: row.status,
    sourceType: row.sourceType,
    sourceRef: row.sourceRef,
    createdAt: row.createdAt.toISOString(),
  };
}
