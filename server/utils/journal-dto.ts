/**
 * 日记 / 手账的接口返回形状。
 *
 * 两份文本是独立产物：详情一次返回 `diary` 与 `handbook` 两个版本对象，
 * 各自带自己的版本号、历史与来源；页面用两个 tab 展示。
 */

import type { PageResult } from "./pagination";

export type JournalTextKindDto = "DIARY" | "HANDBOOK";

export type JournalRevisionShape = {
  id: string;
  journalId: string;
  kind: JournalTextKindDto;
  version: number;
  title: string | null;
  content: string;
  thought: string | null;
  quote: string | null;
  tags: string[];
  sourceDiaryRevisionId: string | null;
  sourceMessageIds: string[];
  sourceEventIds: string[];
  revisionType: string;
  promptVersion: string | null;
  model: string | null;
  editedByUserId: string | null;
  createdAt: Date;
};

export type JournalShape = {
  id: string;
  dayKey: string;
  status: string;
  skipReason: string | null;
  diaryState?: "PENDING" | "GENERATED" | "SKIPPED";
  handbookState?: "PENDING" | "GENERATED" | "SKIPPED";
  diaryDecidedAt?: Date | null;
  handbookDecidedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
  revisions: JournalRevisionShape[];
};

export type JournalRevisionDto = {
  id: string;
  kind: JournalTextKindDto;
  version: number;
  title: string | null;
  content: string;
  thought: string | null;
  quote: string | null;
  tags: string[];
  sourceDiaryRevisionId: string | null;
  /** 这一句摘自第几版日记（页面展示用）。 */
  sourceDiaryVersion: number | null;
  revisionType: string;
  promptVersion: string | null;
  model: string | null;
  editedByUserId: string | null;
  createdAt: string;
  sources: { messages: number; events: number };
};

export type JournalListItemDto = {
  id: string;
  dayKey: string;
  status: "ACTIVE" | "SKIPPED";
  diaryTitle: string | null;
  diaryFirstLine: string;
  handbookQuote: string | null;
  diaryVersion: number;
  handbookVersion: number;
  updatedAt: string;
};

/** 列表页同时给出角色日历，前端不再用浏览器时区算「今天/昨天」。 */
export type JournalPageDto = PageResult<JournalListItemDto> & {
  timeZone: string;
  todayKey: string;
  yesterdayKey: string;
};

export type JournalDetailDto = {
  id: string;
  dayKey: string;
  status: "ACTIVE" | "SKIPPED";
  skipReason: string | null;
  createdAt: string;
  updatedAt: string;
  diaryState: "PENDING" | "GENERATED" | "SKIPPED";
  handbookState: "PENDING" | "GENERATED" | "SKIPPED";
  diaryDecidedAt: string | null;
  handbookDecidedAt: string | null;
  revisionCounts: { diary: number; handbook: number };
  diary: JournalRevisionDto | null;
  handbook: JournalRevisionDto | null;
};

/** Prisma 的版本字段选择：接口和 DTO 共用一份，避免两处漏字段。 */
export const journalRevisionSelect = {
  id: true,
  journalId: true,
  kind: true,
  version: true,
  title: true,
  content: true,
  thought: true,
  quote: true,
  tags: true,
  sourceDiaryRevisionId: true,
  sourceMessageIds: true,
  sourceEventIds: true,
  revisionType: true,
  promptVersion: true,
  model: true,
  editedByUserId: true,
  createdAt: true,
} as const;

/** 列表行上的第一句：到第一个句号/换行为止。 */
export function firstJournalLine(content: string): string {
  const text = content.replace(/\s+/gu, " ").trim();
  if (!text) return "";
  const match = /^(.{1,80}?)[。！？!?]/.exec(text);
  return (match?.[1] ?? text.slice(0, 80)).trim();
}

function latestPerKind(revisions: JournalRevisionShape[]): {
  diary: JournalRevisionShape | null;
  handbook: JournalRevisionShape | null;
} {
  const sorted = [...revisions].sort((a, b) => b.version - a.version);
  return {
    diary: sorted.find((revision) => revision.kind === "DIARY") ?? null,
    handbook: sorted.find((revision) => revision.kind === "HANDBOOK") ?? null,
  };
}

export function toJournalRevisionDto(
  revision: JournalRevisionShape,
  sourceDiaryVersion: number | null = null,
): JournalRevisionDto {
  return {
    id: revision.id,
    kind: revision.kind,
    version: revision.version,
    title: revision.title,
    content: revision.content,
    thought: revision.thought,
    quote: revision.quote,
    tags: revision.tags,
    sourceDiaryRevisionId: revision.sourceDiaryRevisionId,
    sourceDiaryVersion,
    revisionType: revision.revisionType,
    promptVersion: revision.promptVersion,
    model: revision.model,
    editedByUserId: revision.editedByUserId,
    createdAt: revision.createdAt.toISOString(),
    sources: {
      messages: revision.sourceMessageIds.length,
      events: revision.sourceEventIds.length,
    },
  };
}

export function toJournalListItem(journal: JournalShape): JournalListItemDto {
  const { diary, handbook } = latestPerKind(journal.revisions);
  return {
    id: journal.id,
    dayKey: journal.dayKey,
    status: journal.status === "SKIPPED" ? "SKIPPED" : "ACTIVE",
    diaryTitle: diary?.title ?? null,
    diaryFirstLine: diary ? firstJournalLine(diary.content) : "",
    handbookQuote: handbook?.quote ?? null,
    diaryVersion: diary?.version ?? 0,
    handbookVersion: handbook?.version ?? 0,
    updatedAt: journal.updatedAt.toISOString(),
  };
}

export function toJournalDetailDto(
  journal: JournalShape,
  versionInfo: {
    diaryCount: number;
    handbookCount: number;
    diarySourceVersion?: number | null;
  },
): JournalDetailDto {
  const { diary, handbook } = latestPerKind(journal.revisions);
  return {
    id: journal.id,
    dayKey: journal.dayKey,
    status: journal.status === "SKIPPED" ? "SKIPPED" : "ACTIVE",
    skipReason: journal.skipReason,
    createdAt: journal.createdAt.toISOString(),
    updatedAt: journal.updatedAt.toISOString(),
    diaryState: journal.diaryState ?? "PENDING",
    handbookState: journal.handbookState ?? "PENDING",
    diaryDecidedAt: journal.diaryDecidedAt?.toISOString() ?? null,
    handbookDecidedAt: journal.handbookDecidedAt?.toISOString() ?? null,
    revisionCounts: { diary: versionInfo.diaryCount, handbook: versionInfo.handbookCount },
    diary: diary ? toJournalRevisionDto(diary) : null,
    handbook: handbook ? toJournalRevisionDto(handbook, versionInfo.diarySourceVersion ?? null) : null,
  };
}
