import type { SnapshotAnalysis } from "../../app/utils/mock-data";

/**
 * 快照的两种视图：列表只给「一行能显示的字段」，详情才带 AI 提炼结果。
 *
 * 以前列表把 structuredContent 里那份完整分析连同每条来源原文一起塞进同一个响应，
 * 一页 10 份就可能上兆。现在列表只留计数（消息数、事件数、待审核条数），
 * 点开某一版才去取详情，「来源消息与原文」再单独分页拉。
 */
export type MemorySnapshotSummaryDto = {
  id: string;
  /** 自动归档的序号；手动存档恒为 0，不进「第 N 份」序列 */
  number: number;
  /** 列表与详情的标题：自动归档「第 N 份」，手动存档「存档」 */
  label: string;
  version: number;
  date: string;
  range: string;
  summary: string;
  events: number;
  messages: number;
  status: "当前版本" | "已被替代";
  statusTone: "green" | "gray";
  kind: "AUTOMATIC" | "MANUAL";
  generatedBy?: string;
  model?: { name?: string; provider?: string; promptTemplateVersion?: string };
  /** 模型提出、但没过 confidence/来源校验被丢弃的长期记忆变化条数 */
  reviewRejected?: number;
  /** 重新提炼留下的、还没人处置的审核建议条数（列表角的「待审核 N」） */
  pendingReview: number;
};

export type MemorySnapshotDetailDto = MemorySnapshotSummaryDto & {
  analysis?: SnapshotAnalysis;
  /**
   * 依据消息 id → 它在来源列表里的序号（1 起）。
   *
   * 来源消息改成翻页后，前端手里只有当前这一页，没法再从数组下标推算「#3」。
   * 序号由服务端按全量顺序算好给出来，翻到第几页都指同一条。
   */
  evidenceIndex: Record<string, number>;
};

type SnapshotReview = {
  changeIndex: number;
  decision: string;
  memoryItemId: string | null;
  outcome: string | null;
};

export type SnapshotRecord = {
  id: string;
  snapshotKey: string;
  version: number;
  kind: "AUTOMATIC" | "MANUAL";
  periodStart: Date;
  periodEnd: Date;
  summary: string;
  structuredContent: unknown;
  status: string;
  createdAt: Date;
  reviews?: SnapshotReview[];
  /** 列表只需要 sourceType 数条数；时间线只 select 这个字段，所以 message 可缺省 */
  sources?: Array<{
    sourceType: string;
    sourceRef?: string;
    message?: {
      id: string;
      role: string;
      eventType: string;
      content: string;
      occurredAt: Date;
      conversation: { title: string | null };
    } | null;
  }>;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown, limit = 2000): string {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

function readEvidenceIds(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === "string"))].slice(0, 10)
    : [];
}

function readRows<T>(value: unknown, mapper: (record: Record<string, unknown>) => T | null): T[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 80).flatMap((item) => {
    const record = asRecord(item);
    if (!record) return [];
    const mapped = mapper(record);
    return mapped ? [mapped] : [];
  });
}

function readSnapshotAnalysis(value: unknown, reviews: SnapshotReview[] = []): SnapshotAnalysis | undefined {
  const root = asRecord(value);
  const analysis = asRecord(root?.analysis);
  if (!analysis) return undefined;
  // 人工处置结果按数组下标对齐：快照不可变，决定单独存表。
  const reviewByIndex = new Map(reviews.map((review) => [review.changeIndex, review]));

  const withEvidence = (record: Record<string, unknown>) => {
    const evidenceMessageIds = readEvidenceIds(record.evidenceMessageIds);
    return evidenceMessageIds.length > 0 ? evidenceMessageIds : null;
  };

  return {
    importantEvents: readRows(analysis.importantEvents, (record) => {
      const title = readString(record.title, 300);
      const detailText = readString(record.detail);
      const evidenceMessageIds = withEvidence(record);
      return title && detailText && evidenceMessageIds ? { title, detail: detailText, evidenceMessageIds } : null;
    }),
    factAndPreferenceChanges: readRows(analysis.factAndPreferenceChanges, (record) => {
      const description = readString(record.description);
      const changeType = readString(record.changeType, 80);
      const evidenceMessageIds = withEvidence(record);
      return description && evidenceMessageIds ? { description, changeType, evidenceMessageIds } : null;
    }),
    relationshipChanges: readRows(analysis.relationshipChanges, (record) => {
      const description = readString(record.description);
      const evidenceMessageIds = withEvidence(record);
      return description && evidenceMessageIds ? { description, evidenceMessageIds } : null;
    }),
    goalsAndCommitments: readRows(analysis.goalsAndCommitments, (record) => {
      const description = readString(record.description);
      const status = readString(record.status, 80);
      const evidenceMessageIds = withEvidence(record);
      return description && evidenceMessageIds ? { description, status, evidenceMessageIds } : null;
    }),
    unresolvedTopics: readRows(analysis.unresolvedTopics, (record) => {
      const description = readString(record.description);
      const evidenceMessageIds = withEvidence(record);
      return description && evidenceMessageIds ? { description, evidenceMessageIds } : null;
    }),
    differencesFromPrevious: Array.isArray(analysis.differencesFromPrevious)
      ? analysis.differencesFromPrevious.filter((item): item is string => typeof item === "string").map((item) => item.slice(0, 1000)).slice(0, 30)
      : [],
    // 这里不能走 readRows：处置结果要按下标对齐，得保留原始索引。
    memoryChangesApplied: (Array.isArray(root?.memoryChangesApplied) ? root.memoryChangesApplied : [])
      .slice(0, 80)
      .flatMap((raw, index) => {
        const record = asRecord(raw);
        if (!record) return [];
        const action = readString(record.action, 40);
        const result = readString(record.result, 80);
        if (!action || !result) return [];
        const category = readString(record.category, 40);
        const content = readString(record.content);
        const memoryItemId = readString(record.memoryItemId, 100);
        const supersededMemoryId = readString(record.supersededMemoryId, 100);
        const supersededCategory = readString(record.supersededCategory, 40);
        const supersededContent = readString(record.supersededContent);
        const confidence = typeof record.confidence === "number" && Number.isFinite(record.confidence) ? record.confidence : undefined;
        const evidenceMessageIds = readEvidenceIds(record.evidenceMessageIds);
        const review = reviewByIndex.get(index);
        return [{
          action,
          result,
          ...(category ? { category } : {}),
          ...(content ? { content } : {}),
          ...(memoryItemId ? { memoryItemId } : {}),
          ...(supersededMemoryId ? { supersededMemoryId } : {}),
          // 审核建议必须能对上「这条记忆现在写的是什么」，否则「更新」等于没有对照组。
          ...(supersededCategory ? { supersededCategory } : {}),
          ...(supersededContent ? { supersededContent } : {}),
          ...(confidence !== undefined ? { confidence } : {}),
          ...(evidenceMessageIds.length ? { evidenceMessageIds } : {}),
          ...(review
            ? {
                reviewDecision: review.decision === "ACCEPTED" ? "ACCEPTED" as const : "IGNORED" as const,
                ...(review.memoryItemId ? { reviewMemoryItemId: review.memoryItemId } : {}),
                ...(review.outcome ? { reviewOutcome: review.outcome } : {}),
              }
            : {}),
        }];
      }),
  };
}

function readModel(value: unknown): MemorySnapshotSummaryDto["model"] | undefined {
  const root = asRecord(value);
  const model = asRecord(root?.model);
  if (!model) return undefined;
  return {
    ...(readString(model.name, 200) ? { name: readString(model.name, 200) } : {}),
    ...(readString(model.provider, 500) ? { provider: readString(model.provider, 500) } : {}),
    ...(readString(model.promptTemplateVersion, 100) ? { promptTemplateVersion: readString(model.promptTemplateVersion, 100) } : {}),
  };
}

export function formatSnapshotDate(value: Date, timeZone = "Asia/Shanghai", includeTime = false): string {
  const options: Intl.DateTimeFormatOptions = {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...(includeTime ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" as const } : {}),
  };
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-CA", options).formatToParts(value);
  } catch {
    parts = new Intl.DateTimeFormat("en-CA", { ...options, timeZone: "UTC" }).formatToParts(value);
  }
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const date = [values.year, values.month, values.day].join("-");
  return includeTime ? date + " " + values.hour + ":" + values.minute : date;
}

function readEventCount(value: unknown): number {
  const root = asRecord(value);
  if (!root) return 0;
  if (typeof root.eventCount === "number" && Number.isFinite(root.eventCount)) {
    return Math.max(0, root.eventCount);
  }
  const counts = asRecord(root.counts);
  if (typeof counts?.eventCount === "number" && Number.isFinite(counts.eventCount)) {
    return Math.max(0, counts.eventCount);
  }
  const analysis = asRecord(root.analysis);
  if (Array.isArray(analysis?.importantEvents)) return analysis.importantEvents.length;
  return Array.isArray(root.events) ? root.events.length : 0;
}

/**
 * 待人工处置的长期记忆变化条数。
 *
 * 与前端 `reviewPending` 同一套判定：重新提炼留下的建议、且还没有处置记录。
 * 只数条数，不把建议本身带进列表 —— 列表角标要的就是这个数字。
 */
function readPendingReviewCount(value: unknown, reviews: SnapshotReview[] = []): number {
  const changes = asRecord(value)?.memoryChangesApplied;
  if (!Array.isArray(changes)) return 0;
  const reviewed = new Set(reviews.map((review) => review.changeIndex));
  return changes.reduce((total, raw, index) => {
    const record = asRecord(raw);
    if (!record || reviewed.has(index)) return total;
    return readString(record.result, 80) === "NOT_APPLIED_REGENERATION" ? total + 1 : total;
  }, 0);
}

/**
 * 「第 N 份」只数自动归档。
 *
 * 手动存档以前也占序号：点几次「存档」就凭空多出第 1、3、5 份，AI 总结被挤到第 2、4 份，
 * 读起来像「归档了五次、其中三次没内容」。存档不是一份总结，不进这个序列。
 *
 * 分页后不能靠「手上这批记录」推算序号：第 2 页的第一条可能是第 9 份。
 * 所以先把角色名下所有自动快照的 snapshotKey 按最早生成时间排一遍，页码再从那里面查。
 */
export function buildSnapshotSequence(
  records: Array<{ snapshotKey: string; createdAt: Date }>,
): Map<string, number> {
  const chronological = [...records].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const sequenceByKey = new Map<string, number>();
  let automaticCount = 0;
  for (const record of chronological) {
    if (sequenceByKey.has(record.snapshotKey)) continue;
    automaticCount += 1;
    sequenceByKey.set(record.snapshotKey, automaticCount);
  }
  return sequenceByKey;
}

function toSummary(
  record: SnapshotRecord,
  timeZone: string,
  sequenceByKey: Map<string, number>,
): MemorySnapshotSummaryDto {
  const current = record.status === "CURRENT";
  const structured = asRecord(record.structuredContent);
  const model = readModel(record.structuredContent);
  const generatedBy = readString(structured?.generatedBy, 100);
  const rejectedRaw = structured?.memoryChangesRejected;
  const reviewRejected = typeof rejectedRaw === "number" && Number.isFinite(rejectedRaw)
    ? Math.max(0, Math.floor(rejectedRaw))
    : 0;
  const number = record.kind === "AUTOMATIC" ? (sequenceByKey.get(record.snapshotKey) ?? 1) : 0;
  return {
    id: record.id,
    number,
    label: number > 0 ? `第 ${number} 份` : "存档",
    version: record.version,
    date: formatSnapshotDate(record.createdAt, timeZone, true),
    range: formatSnapshotDate(record.periodStart, timeZone) + " — " + formatSnapshotDate(record.periodEnd, timeZone),
    summary: record.summary,
    events: readEventCount(record.structuredContent),
    messages: (record.sources ?? []).filter((source) => source.sourceType === "MESSAGE").length,
    status: current ? "当前版本" : "已被替代",
    statusTone: current ? "green" : "gray",
    kind: record.kind,
    ...(generatedBy ? { generatedBy } : {}),
    ...(model ? { model } : {}),
    ...(reviewRejected ? { reviewRejected } : {}),
    pendingReview: readPendingReviewCount(record.structuredContent, record.reviews ?? []),
  };
}

/** 列表用：只给一页摘要，不含 AI 提炼结果与来源原文。 */
export function toMemorySnapshotSummaries(
  records: SnapshotRecord[],
  timeZone = "Asia/Shanghai",
  sequenceByKey?: Map<string, number>,
): MemorySnapshotSummaryDto[] {
  const sequence = sequenceByKey ?? buildSnapshotSequence(records);
  return [...records]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.version - a.version)
    .map((record) => toSummary(record, timeZone, sequence));
}

/** 详情用：摘要 + AI 提炼结果 + 依据序号；来源原文按需另取。 */
export function toMemorySnapshotDetail(
  record: SnapshotRecord,
  timeZone: string,
  options: { sequenceByKey?: Map<string, number>; sourceMessageIds?: string[] } = {},
): MemorySnapshotDetailDto {
  const sequence = options.sequenceByKey ?? buildSnapshotSequence([record]);
  const analysis = readSnapshotAnalysis(record.structuredContent, record.reviews ?? []);
  const sourceMessageIds = options.sourceMessageIds ?? (record.sources ?? [])
    .filter((source) => source.sourceType === "MESSAGE" && source.message)
    .map((source) => source.message!.id);
  return {
    ...toSummary(record, timeZone, sequence),
    ...(analysis ? { analysis } : {}),
    evidenceIndex: buildEvidenceIndex(analysis, sourceMessageIds),
  };
}

/** 只给被引用的消息算序号：给全量消息建表会把详情响应又撑成一个大包。 */
function buildEvidenceIndex(analysis: SnapshotAnalysis | undefined, sourceMessageIds: string[]): Record<string, number> {
  if (!analysis || sourceMessageIds.length === 0) return {};
  const referenced = new Set<string>();
  const collect = (items: Array<{ evidenceMessageIds?: string[] }>) => {
    for (const item of items) for (const id of item.evidenceMessageIds ?? []) referenced.add(id);
  };
  collect(analysis.importantEvents);
  collect(analysis.factAndPreferenceChanges);
  collect(analysis.relationshipChanges);
  collect(analysis.goalsAndCommitments);
  collect(analysis.unresolvedTopics);
  collect(analysis.memoryChangesApplied);
  if (referenced.size === 0) return {};

  const positionById = new Map(sourceMessageIds.map((id, index) => [id, index + 1]));
  const index: Record<string, number> = {};
  for (const id of referenced) {
    const position = positionById.get(id);
    if (position) index[id] = position;
  }
  return index;
}

/** 兼容旧调用：时间线只需要摘要字段。 */
export function toMemorySnapshotDtos(
  records: SnapshotRecord[],
  timeZone = "Asia/Shanghai",
): MemorySnapshotSummaryDto[] {
  return toMemorySnapshotSummaries(records, timeZone);
}
