import type { SnapshotAnalysis } from "../../app/utils/mock-data";

export type MemorySnapshotDto = {
  id: string;
  number: number;
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
  analysis?: SnapshotAnalysis;
  /** 模型提出、但没过 confidence/来源校验被丢弃的长期记忆变化条数 */
  reviewRejected?: number;
  sourceMessages: Array<{
    id: string;
    role: string;
    eventType: string;
    content: string;
    occurredAt: string;
    conversationTitle: string | null;
  }>;
};

type SnapshotReview = {
  changeIndex: number;
  decision: string;
  memoryItemId: string | null;
  outcome: string | null;
};

type SnapshotRecord = {
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
  sources: Array<{
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
      const detail = readString(record.detail);
      const evidenceMessageIds = withEvidence(record);
      return title && detail && evidenceMessageIds ? { title, detail, evidenceMessageIds } : null;
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

function readModel(value: unknown): MemorySnapshotDto["model"] | undefined {
  const root = asRecord(value);
  const model = asRecord(root?.model);
  if (!model) return undefined;
  return {
    ...(readString(model.name, 200) ? { name: readString(model.name, 200) } : {}),
    ...(readString(model.provider, 500) ? { provider: readString(model.provider, 500) } : {}),
    ...(readString(model.promptTemplateVersion, 100) ? { promptTemplateVersion: readString(model.promptTemplateVersion, 100) } : {}),
  };
}

function formatDate(value: Date, timeZone: string, includeTime = false): string {
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

export function toMemorySnapshotDtos(
  records: SnapshotRecord[],
  timeZone = "Asia/Shanghai",
): MemorySnapshotDto[] {
  const chronological = [...records].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const sequenceByKey = new Map<string, number>();
  for (const record of chronological) {
    if (!sequenceByKey.has(record.snapshotKey)) {
      sequenceByKey.set(record.snapshotKey, sequenceByKey.size + 1);
    }
  }

  return [...records]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.version - a.version)
    .map((record) => {
      const current = record.status === "CURRENT";
      const structured = asRecord(record.structuredContent);
      const model = readModel(record.structuredContent);
      const generatedBy = readString(structured?.generatedBy, 100);
      const analysis = readSnapshotAnalysis(record.structuredContent, record.reviews ?? []);
      const rejectedRaw = structured?.memoryChangesRejected;
      const reviewRejected = typeof rejectedRaw === "number" && Number.isFinite(rejectedRaw)
        ? Math.max(0, Math.floor(rejectedRaw))
        : 0;
      return {
        id: record.id,
        number: sequenceByKey.get(record.snapshotKey) ?? 1,
        version: record.version,
        date: formatDate(record.createdAt, timeZone, true),
        range: formatDate(record.periodStart, timeZone) + " — " + formatDate(record.periodEnd, timeZone),
        summary: record.summary,
        events: readEventCount(record.structuredContent),
        messages: record.sources.filter((source) => source.sourceType === "MESSAGE").length,
        status: current ? "当前版本" : "已被替代",
        statusTone: current ? "green" : "gray",
        kind: record.kind,
        ...(generatedBy ? { generatedBy } : {}),
        ...(model ? { model } : {}),
        ...(analysis ? { analysis } : {}),
        ...(reviewRejected ? { reviewRejected } : {}),
        sourceMessages: record.sources
          .filter((source) => source.sourceType === "MESSAGE" && source.message)
          .map((source) => ({
            id: source.message!.id,
            role: source.message!.role,
            eventType: source.message!.eventType,
            content: source.message!.content,
            occurredAt: source.message!.occurredAt.toISOString(),
            conversationTitle: source.message!.conversation.title,
          })),
      };
    });
}
