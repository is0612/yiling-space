/**
 * 知识域的前后端共享契约。
 *
 * 这一域的接口形状比成长域「软」：`category` / `sourceType` 是自由字符串
 * （来源类型会随功能扩展，写死枚举只会让新来源在类型层先挂一次），
 * 所以只有 `status` 收窄成四值 —— 那是状态机的真实取值集合。
 *
 * `sourceRef` 是 Json：不同来源（手动 / 忆泡 / 网页 / 话题）写进去的结构不同，
 * 契约如实记为 `unknown`，不假装它有一种形状。
 */

export const KNOWLEDGE_ITEM_STATUSES = ["ACTIVE", "ARCHIVED", "TRASHED", "MERGED"] as const;
export type KnowledgeItemStatus = typeof KNOWLEDGE_ITEM_STATUSES[number];

/** 候选建议里的「相关条目」摘要：只够显示一行，不带正文之外的重字段。 */
export type KnowledgeRelatedItem = {
  id: string;
  title: string;
  content: string;
  category: string;
  tags: string[];
  revision: number;
};

/**
 * 知识条目（`knowledge_items` 的一行）。
 *
 * `canPermanentlyDelete` 只由回收站接口给：参与过合并审计链的条目不能物理删除，
 * 页面用它禁用按钮。它不是删除依据，服务端仍会自己再判一次。
 */
export type KnowledgeEntry = {
  id: string;
  title: string;
  content: string;
  category: string;
  tags: string[];
  confidence: number | null;
  status: KnowledgeItemStatus;
  sourceType: string;
  sourceRef: unknown;
  revision: number;
  createdAt: string;
  updatedAt: string;
  canPermanentlyDelete?: boolean;
};

/** 条目之间的关系视图：`relatedItem` 是从当前条目看过去的另一端。 */
export type KnowledgeRelationView = {
  id: string;
  sourceItemId: string;
  targetItemId: string;
  relationType: string;
  status: string;
  resolution: string | null;
  metadata: unknown;
  updatedAt: string;
  relatedItem: {
    id: string;
    title: string;
    content: string;
    category: string;
    tags: string[];
    confidence: number | null;
    status: string;
    revision: number;
    sourceType: string;
    sourceRef: unknown;
  };
};

/** 工作台里的条目 = 条目本体 + 它的关系。 */
export type KnowledgeItem = KnowledgeEntry & { relations: KnowledgeRelationView[] };

/** 历史版本：`knowledge_item_revisions` 的一行，没有 updatedAt（版本本身不可变）。 */
export type KnowledgeItemRevision = {
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
  createdAt: string;
};

export type KnowledgePagination = { page: number; pageSize: number; total: number; pageCount: number };

/** AI 对一条候选的判断：建新条目 / 判重 / 冲突 / 丢弃。这是固定四值。 */
export const KNOWLEDGE_RECOMMENDATIONS = ["CREATE", "DUPLICATE", "CONFLICT", "DISCARD"] as const;
export type KnowledgeRecommendation = typeof KNOWLEDGE_RECOMMENDATIONS[number];

/**
 * 模型对候选内容的判断结果，落在 `knowledge_candidates.processedResult` 这个 Json 列里。
 *
 * `confirmedRelatedItemIds` 是「用户在关联里确认过」的那部分，只有部分流程会写。
 */
export type KnowledgeResult = {
  isKnowledge: boolean;
  recommendation: KnowledgeRecommendation;
  title: string;
  content: string;
  category: string;
  tags: string[];
  confidence: number;
  reason: string;
  relatedItemIds: string[];
  confirmedRelatedItemIds?: string[];
};

/**
 * 知识候选（`knowledge_candidates` 的一行）。
 *
 * `status` 保持自由字符串：候选的状态流转比条目复杂（PENDING / 处理中 /
 * DISMISSED / ACCEPTED 由不同流程写入），写死枚举会让新增流程先在类型层挂一次。
 * 条目的四值状态是有状态机的，候选的没有。
 */
export type KnowledgeCandidate = {
  id: string;
  sourceType: string;
  sourceRef: unknown;
  rawContent: string;
  status: string;
  /** 还没跑过 AI 判断时是 null；跑失败时看 `processingError`。 */
  processedResult: KnowledgeResult | null;
  processingError: string | null;
  processedAt: string | null;
  createdAt: string;
  /** 建议关联到的现有条目（服务端按 `relatedItemIds` 现查，只给一行够用的字段）。 */
  relatedItems: KnowledgeRelatedItem[];
};
