/**
 * 阶段总结（快照）的前后端共享契约。
 *
 * 这批形状原先只有一份定义在 `app/utils/mock-data.ts`（前端），而服务端的
 * `server/utils/memory-snapshot-dto.ts` 反过来 import 前端的类型 —— 服务端依赖前端，
 * 这是方向错了。现在两边都指向这里。
 *
 * 注意 `status` / `statusTone` 是**服务端算好的展示态**（中文字面量直接进 API）：
 * 「当前版本 / 已被替代」的判定牵涉版本链，不该让每个页面各判一次。这是既有设计，
 * 契约照实记录，不当成缺陷去改。
 */

export const SNAPSHOT_KINDS = ["AUTOMATIC", "MANUAL"] as const;
export type SnapshotKind = typeof SNAPSHOT_KINDS[number];

export const SNAPSHOT_STATUSES = ["CURRENT", "SUPERSEDED"] as const;
export type SnapshotStatus = typeof SNAPSHOT_STATUSES[number];

/** AI 从这一段对话里提炼出的结构；`structuredContent` 落库后由 DTO 读出来。 */
export type SnapshotAnalysis = {
  importantEvents: Array<{ title: string; detail: string; evidenceMessageIds: string[] }>;
  factAndPreferenceChanges: Array<{ description: string; changeType: string; evidenceMessageIds: string[] }>;
  relationshipChanges: Array<{ description: string; evidenceMessageIds: string[] }>;
  goalsAndCommitments: Array<{ description: string; status: string; evidenceMessageIds: string[] }>;
  unresolvedTopics: Array<{ description: string; evidenceMessageIds: string[] }>;
  differencesFromPrevious: string[];
  memoryChangesApplied: Array<{
    action: string;
    result: string;
    category?: string;
    content?: string;
    memoryItemId?: string;
    supersededMemoryId?: string;
    /** 被这条建议指向的旧记忆当前的内容 / 类别，用来做「改成什么 vs 现在是什么」的对照 */
    supersededCategory?: string;
    supersededContent?: string;
    confidence?: number;
    evidenceMessageIds?: string[];
    /** 人工处置结果；undefined 表示还没人处理过 */
    reviewDecision?: "ACCEPTED" | "IGNORED";
    reviewMemoryItemId?: string;
    reviewOutcome?: string;
  }>;
};

/** 来源消息：分页接口一行。`index` 是全量顺序里的序号（1 起），翻页后仍指向同一条。 */
export type SnapshotSourceMessage = {
  index?: number;
  id: string;
  role: string;
  eventType: string;
  content: string;
  occurredAt: string;
  conversationTitle: string | null;
};

/**
 * 列表行：只带一行能显示的字段，不含 AI 提炼结果与来源原文。
 *
 * `label` / `kind` / `pendingReview` 在服务端**总是有值**（label 由 kind 与序号算出，
 * pendingReview 由未处置审核条数算出），所以契约写必填 —— 前端原先写成可选，
 * 会让「忘传」在页面层悄悄通过。
 */
export type Snapshot = {
  id: string;
  /** 自动归档的序号；手动存档恒为 0，不进「第 N 份」序列 */
  number: number;
  /** 自动归档「第 N 份」，手动存档「存档」 */
  label: string;
  version: number;
  date: string;
  range: string;
  summary: string;
  events: number;
  messages: number;
  status: "当前版本" | "已被替代";
  statusTone: "green" | "gray";
  kind: SnapshotKind;
  generatedBy?: string;
  model?: { name?: string; provider?: string; promptTemplateVersion?: string };
  /** 模型提出、但没过 confidence/来源校验被丢弃的长期记忆变化条数 */
  reviewRejected?: number;
  /** 待人工处置的审核建议条数；列表角标直接用它 */
  pendingReview: number;
};

/** 详情：摘要 + AI 提炼结果；来源原文走 `/snapshots/{id}/sources` 分页接口。 */
export type SnapshotDetail = Snapshot & {
  analysis?: SnapshotAnalysis;
  /** 依据消息 id → 来源列表里的序号；「依据 #3」靠它，不依赖当前这一页 */
  evidenceIndex: Record<string, number>;
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
