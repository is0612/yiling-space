import type { KnowledgeTopicStatus, KnowledgeTopicSummary } from "../../shared/types/knowledge";

export type KnowledgeTopicRow = {
  id: string;
  name: string;
  description: string;
  status: KnowledgeTopicStatus;
  revision: number;
  mergedIntoId: string | null;
  mergedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * 把 `knowledge_topics` 的一行整形成列表 DTO（`shared/types/knowledge.ts`）。
 *
 * 列表接口原先 `({ _count, ...topic }) => ({ ...topic, memberCount: _count.members })`：
 * 除了拍平计数，`mergedAt` / `createdAt` / `updatedAt` 还是 `Date`（靠 Nitro 序列化），
 * `characterId` 也会跟着 spread 漏出去（现在 select 里没取，但整形函数不该依赖这一点）。
 */
export function toKnowledgeTopicSummary(row: KnowledgeTopicRow, memberCount: number): KnowledgeTopicSummary {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    revision: row.revision,
    mergedIntoId: row.mergedIntoId,
    mergedAt: row.mergedAt ? row.mergedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    memberCount,
  };
}
