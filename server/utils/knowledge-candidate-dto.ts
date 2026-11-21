import type { KnowledgeCandidate, KnowledgeResult } from "../../shared/types/knowledge";

export type KnowledgeCandidateRow = {
  id: string;
  sourceType: string;
  sourceRef: unknown;
  rawContent: string;
  status: string;
  processedResult: unknown;
  processingError: string | null;
  processedAt: Date | null;
  createdAt: Date;
};

/**
 * 把 `knowledge_candidates` 的一行整形成候选 DTO（`shared/types/knowledge.ts`）。
 *
 * 之前列表接口对候选也是 `{ ...candidate }`：`processedAt` / `createdAt` 是 `Date`
 * （靠 Nitro 序列化变成 ISO），`characterId` 与 `updatedAt` 一并漏出去。
 * `relatedItems` 由调用方按 `relatedItemIds` 现查后挂上，不在这里查库。
 *
 * `processedResult` 原样带出并断言成契约形状：它是 `knowledge-ai.ts` 写进去的，
 * 形状由那条链路保证；这里再"校验一遍"只会把 AI 输出悄悄改坏。
 */
export function toKnowledgeCandidate(row: KnowledgeCandidateRow): Omit<KnowledgeCandidate, "relatedItems"> {
  return {
    id: row.id,
    sourceType: row.sourceType,
    sourceRef: row.sourceRef,
    rawContent: row.rawContent,
    status: row.status,
    processedResult: (row.processedResult ?? null) as KnowledgeResult | null,
    processingError: row.processingError,
    processedAt: row.processedAt ? row.processedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}
