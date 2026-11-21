/**
 * 日记 / 手账的前后端共享契约（**响应形状**）。
 *
 * 范围说明：本次只收类型层。服务端生成逻辑（`journal-service.ts`、`journal-ai.ts`）
 * 正由另一条线修改，这里不加 `satisfies` 标注，避免把两边的未提交改动搅在一起。
 * 等服务端稳定后再回来补断言 —— 所以这批形状目前是「前端唯一来源」，
 * 还不是「已由后端校验过的契约」。
 *
 * 请求类型（`*Req`）仍留在 `app/api/journal.ts`：它们是入参，没有响应形状的问题。
 */

export const JOURNAL_KINDS = ["DIARY", "HANDBOOK"] as const;
export type JournalKind = typeof JOURNAL_KINDS[number];

export const JOURNAL_DAY_STATUSES = ["ACTIVE", "SKIPPED"] as const;
export type JournalDayStatus = typeof JOURNAL_DAY_STATUSES[number];

/** 列表行：只够画一行卡片，正文用 firstLine / quote 摘要。 */
export type JournalListItem = {
  id: string;
  dayKey: string;
  status: JournalDayStatus;
  diaryTitle: string | null;
  diaryFirstLine: string;
  handbookQuote: string | null;
  diaryVersion: number;
  handbookVersion: number;
  updatedAt: string;
};

/**
 * 一个版本的正文。
 *
 * `editedByUserId` 为 null 表示模型生成、无人编辑；有值表示人工改过。
 * `sources` 是这一版参考了多少条消息与忆泡，只给计数、不给原文。
 */
export type JournalRevision = {
  id: string;
  kind: JournalKind;
  version: number;
  title: string | null;
  content: string;
  thought: string | null;
  quote: string | null;
  tags: string[];
  sourceDiaryRevisionId: string | null;
  sourceDiaryVersion: number | null;
  revisionType: string;
  promptVersion: string | null;
  model: string | null;
  editedByUserId: string | null;
  createdAt: string;
  sources: { messages: number; events: number };
};

/** 某一天的详情：日记与手账各自的状态 + 当前版本。 */
export type JournalDetail = {
  id: string;
  dayKey: string;
  status: JournalDayStatus;
  skipReason: string | null;
  createdAt: string;
  updatedAt: string;
  diaryState: "PENDING" | "GENERATED" | "SKIPPED";
  handbookState: "PENDING" | "GENERATED" | "SKIPPED";
  diaryDecidedAt: string | null;
  handbookDecidedAt: string | null;
  revisionCounts: { diary: number; handbook: number };
  diary: JournalRevision | null;
  handbook: JournalRevision | null;
};

export type JournalPage = {
  items: JournalListItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  hasMore: boolean;
  timeZone: string;
  todayKey: string;
  yesterdayKey: string;
};

/** 写入/重生成的结果：`status` 是业务状态，`reason` 给人看。 */
export type JournalWriteResult = { status: string; reason?: string };
