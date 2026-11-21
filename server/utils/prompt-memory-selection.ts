/**
 * 「这一轮往提示词里放哪些记忆」的唯一选择点。
 *
 * 网页聊天（chat.post.ts）和 QQ 管道（channel-adapter/pipeline.ts）此前各写一遍：
 * 同样的预算装配、同样的 scope 标签、同样的忆泡 600 字截断、同样的人数名刷新。
 * 结果是一边修好、另一边照旧 —— 2026-11 那次「网页合成测试过、QQ 实际管道仍接不上
 * 上一句」就是这么漏的。
 *
 * 这里只做**选择与整形**：候选从哪来、授权范围怎么定、群聊只看本群，仍由各入口负责；
 * 本模块不决定要不要回、不写库。行为与抽取前逐字节一致。
 */

import { pickPersonCueEvent } from "./person-cue";
import { estimateTokens, rankMemoriesWithBudget, rankSnapshotsWithBudget, type BudgetedRank } from "./memory-retrieval";
import { selectEventsForPrompt, selectRecentEvents, type EventCandidate, type SelectedEvents } from "./memory-event-retrieval";

/** 忆泡注入提示词时的正文上限。改这个数字等于改提示词内容，两边必须一起变。 */
export const PROMPT_EVENT_DETAIL_MAX_CHARS = 600;

export type PromptScope = "character" | "private";

export type PromptMemoryCandidate = {
  id: string;
  category: string;
  content: string;
  confidence: number | null;
  validFrom: Date | null;
  createdAt: Date;
  memoryScopeId: string;
  importance?: number | null;
  recallCount?: number | null;
  lastRecalledAt?: Date | null;
  updatedAt?: Date | null;
};

export type PromptSnapshotCandidate = {
  id: string;
  summary: string;
  periodStart: Date;
  periodEnd: Date;
  version: number;
  createdAt: Date;
  memoryScopeId: string;
};

export type PromptEventCandidate = EventCandidate & { memoryScopeId: string };

export type PromptMemoryItem = {
  id: string;
  category: string;
  content: string;
  confidence: number | null;
  relevanceScore: number;
  scope: PromptScope;
  /** 这条记忆是什么时候的：有 validFrom 用它（事实成立时间），否则退回入库时间。 */
  occurredAt: string;
};

export type PromptSnapshotItem = {
  id: string;
  summary: string;
  periodStart: string;
  periodEnd: string;
  version: number;
  relevanceScore: number;
  scope: PromptScope;
};

export type PromptEventItem = {
  id: string;
  occurredAt: string;
  timeOfDay?: string;
  place?: string;
  participants: string[];
  title: string;
  detail: string;
  scope: PromptScope;
};

export type PromptSelectionDiagnostics = {
  memory: { count: number; usedTokens: number; dropped: number };
  snapshot: { count: number; usedTokens: number; dropped: number };
  event: { count: number; mode: SelectedEvents<PromptEventCandidate>["mode"]; usedTokens: number; dropped: number };
  recentEvent: { count: number };
};

export type PromptMemorySelection<TEvent extends PromptEventCandidate> = {
  memories: PromptMemoryItem[];
  snapshots: PromptSnapshotItem[];
  events: PromptEventItem[];
  recentEvents: PromptEventItem[];
  /** 忆泡选择结果本体：原文兜底要读 `range`，调用方仍需它。 */
  eventSelection: SelectedEvents<TEvent>;
  selection: PromptSelectionDiagnostics;
};

function budgetDiagnostics<T>(ranked: BudgetedRank<T>) {
  return { count: ranked.items.length, usedTokens: ranked.usedTokens, dropped: ranked.dropped };
}

/**
 * 选这一轮要放进去的记忆、阶段总结与忆泡。
 *
 * `loadParticipantNames` 由调用方注入：名字刷新要查库（群名片会改），不属于纯选择。
 * 它收到的顺序就是「先选中、后近期」两批拼起来的顺序。
 */
export async function selectPromptMemoryContext<TEvent extends PromptEventCandidate>(input: {
  query: string;
  now: Date;
  timeZone: string;
  memoryCandidates: PromptMemoryCandidate[];
  snapshotCandidates: PromptSnapshotCandidate[];
  eventCandidates: TEvent[];
  participantIds: readonly string[];
  /** Caller supplies only authorized current-group candidates; omitted means disabled. */
  personCue?: { speakerIds: readonly string[]; platform: string };
  limits: {
    memoryItems: number;
    memoryTokens: number;
    snapshots: number;
    snapshotTokens: number;
    events: number;
    eventTokens: number;
    recentEventDays: number;
  };
  scopeOf: (memoryScopeId: string) => PromptScope;
  loadParticipantNames: (events: readonly TEvent[]) => Promise<readonly (readonly string[])[]>;
}): Promise<PromptMemorySelection<TEvent>> {
  const memoryRank = rankMemoriesWithBudget(input.query, input.memoryCandidates, {
    limit: input.limits.memoryItems,
    tokenBudget: input.limits.memoryTokens,
  });
  const memories = memoryRank.items.map((memory): PromptMemoryItem => ({
    id: memory.id,
    category: memory.category,
    content: memory.content.slice(0, 1200),
    confidence: memory.confidence,
    relevanceScore: memory.relevanceScore,
    scope: input.scopeOf(memory.memoryScopeId),
    occurredAt: (memory.validFrom ?? memory.createdAt).toISOString(),
  }));

  const snapshotRank = rankSnapshotsWithBudget(input.query, input.snapshotCandidates, {
    limit: input.limits.snapshots,
    tokenBudget: input.limits.snapshotTokens,
  });
  const snapshots = snapshotRank.items.map((snapshot): PromptSnapshotItem => ({
    id: snapshot.id,
    summary: snapshot.summary.slice(0, 3000),
    periodStart: snapshot.periodStart.toISOString(),
    periodEnd: snapshot.periodEnd.toISOString(),
    version: snapshot.version,
    relevanceScore: snapshot.relevanceScore,
    scope: input.scopeOf(snapshot.memoryScopeId),
  }));

  const eventSelection = selectEventsForPrompt(input.query, input.eventCandidates, {
    now: input.now,
    timeZone: input.timeZone,
    tokenBudget: input.limits.eventTokens,
    limit: input.limits.events,
    ...(input.participantIds.length ? { participantIds: input.participantIds } : {}),
  });

  const recentEventSelection = input.limits.recentEventDays > 0
    ? selectRecentEvents(input.eventCandidates, {
        days: input.limits.recentEventDays,
        excludeIds: new Set(eventSelection.items.map((event) => event.id)),
        // 与本次选择共用一个时钟：否则跨零点/跨请求时，「最近几天」会和上面的日期补查对不上。
        now: input.now,
      })
    : null;
  const recentEventItems = recentEventSelection?.items ?? [];

  // Optional cues use only spare ordinary-event budget and slots. Never displace
  // a direct answer, never receive the first-item oversize exception.
  if (input.personCue && eventSelection.items.length < input.limits.events) {
    const picked = pickPersonCueEvent({
      query: input.query,
      events: input.eventCandidates,
      speakerIds: input.personCue.speakerIds,
      platform: input.personCue.platform,
      excludeIds: new Set([...eventSelection.items, ...recentEventItems].map(item => item.id)),
    }).event;
    if (picked) {
      const tokens = estimateTokens([
        picked.title, picked.detail, picked.place ?? "", picked.timeOfDay ?? "",
        picked.keywords.join(" "), picked.participants.join(" "),
      ].filter(Boolean).join("\n"));
      if (eventSelection.usedTokens + tokens <= input.limits.eventTokens) {
        eventSelection.items.push({ ...picked, relevanceScore: 0, tokens });
        eventSelection.usedTokens += tokens;
      }
    }
  }

  const participantNames = eventSelection.items.length + recentEventItems.length
    ? await input.loadParticipantNames([...eventSelection.items, ...recentEventItems])
    : [];

  const toPromptEvent = (event: TEvent, index: number): PromptEventItem => ({
    id: event.id,
    occurredAt: event.occurredAt.toISOString(),
    ...(event.timeOfDay ? { timeOfDay: event.timeOfDay } : {}),
    ...(event.place ? { place: event.place } : {}),
    participants: [...(participantNames[index] ?? event.participants)],
    title: event.title,
    detail: event.detail.slice(0, PROMPT_EVENT_DETAIL_MAX_CHARS),
    scope: input.scopeOf(event.memoryScopeId),
  });

  const events = eventSelection.items.map((event, index) => toPromptEvent(event, index));
  const recentEvents = recentEventItems.map((event, index) => toPromptEvent(event, eventSelection.items.length + index));

  return {
    memories,
    snapshots,
    events,
    recentEvents,
    eventSelection,
    selection: {
      memory: budgetDiagnostics(memoryRank),
      snapshot: budgetDiagnostics(snapshotRank),
      event: {
        count: eventSelection.items.length,
        mode: eventSelection.mode,
        usedTokens: eventSelection.usedTokens,
        dropped: eventSelection.dropped,
      },
      recentEvent: { count: recentEventItems.length },
    },
  };
}
