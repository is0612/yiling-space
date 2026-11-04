/**
 * 忆泡的选择与排序。
 *
 * 和长期记忆不一样：记忆是「她知道的结论」，检索按相关度挑几条就够；
 * 忆泡是「发生过的事」，问「前天我做了什么」时要的是**那一天的清单**，
 * 所以先按时间区间框住，再排序；框不住才退化成关键词。
 */

import { estimateTokens, extractRetrievalTerms } from "./memory-retrieval";
import { parseEventTimeRange, type EventTimeRange } from "./memory-event-time";

export const EVENT_TOKEN_BUDGET_DEFAULT = 800;
export const EVENT_LIMIT_DEFAULT = 8;

/**
 * 近期忆泡：最近几天的「我干了什么」，不靠关键词命中，每轮无条件带上当背景。
 *
 * 和 `selectEventsForPrompt` 的分工是两件事：
 * 那个回答「你问的那件事我记得吗」，这个回答「我这两天在过什么日子」。
 * 群聊里没人会问日期，可聊着聊着需要知道「昨天约过什么」——所以这一份不看问句。
 * 默认 0 = 关闭：它是背景，不是所有人都想每轮多背几百 token。
 */
export const EVENT_RECENT_DAYS_DEFAULT = 0;
export const EVENT_RECENT_LIMIT_DEFAULT = 6;
export const EVENT_RECENT_TOKEN_BUDGET = 600;

export type EventCandidate = {
  id: string;
  title: string;
  detail: string;
  occurredAt: Date;
  timeOfDay?: string | null;
  place?: string | null;
  participants: string[];
  keywords: string[];
  /** 结构化参与者引用（self / owner / external）。有就优先按账号过滤，没有就退回显示名。 */
  participantRefs?: unknown;
};

export type RankedEvent<T> = T & {
  relevanceScore: number;
  tokens: number;
};

export type SelectedEvents<T> = {
  items: RankedEvent<T>[];
  /** 命中的时间区间；null = 没认出日期，走的是关键词。 */
  range: EventTimeRange | null;
  usedTokens: number;
  dropped: number;
  /** 这一轮是按什么选出来的：时间区间 / 参与者 / 第一次 / 关键词。 */
  mode: "range" | "participant" | "first" | "latest" | "keyword";
};

export type EventSelectionOptions = {
  now?: Date;
  timeZone?: string;
  tokenBudget?: number;
  limit?: number;
  /**
   * 问句里那个人对应的平台账号（QQ 号）。
   *
   * 名字是入口，账号才是身份：群名片改一次，「小明」就变成了「阿鲸」，而忆泡里存的
   * 还是当时的写法 —— 只比字符串，问新名字一条都查不到。调用方先用
   * `resolveParticipantAccounts()` 把名字解析成账号，这里再用账号兜住改名。
   */
  participantIds?: readonly string[];
};

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

function eventText(event: EventCandidate): string {
  return [
    event.title,
    event.detail,
    event.place ?? "",
    event.timeOfDay ?? "",
    event.keywords.join(" "),
    event.participants.join(" "),
  ].filter(Boolean).join("\n");
}

function scoreByKeywords(query: string, event: EventCandidate): { score: number; tokens: number } {
  const text = normalize(eventText(event));
  const terms = extractRetrievalTerms(query);
  let hit = 0;
  for (const term of terms) {
    if (!term) continue;
    if (text.includes(normalize(term))) hit += term.length >= 3 ? 1.5 : 1;
  }
  return {
    score: Math.round(hit * 100) / 100,
    tokens: estimateTokens(eventText(event)),
  };
}

function applyBudget<T extends EventCandidate>(
  ranked: Array<RankedEvent<T>>,
  tokenBudget: number,
  limit: number,
): { items: Array<RankedEvent<T>>; usedTokens: number; dropped: number } {
  const items: Array<RankedEvent<T>> = [];
  let usedTokens = 0;
  let dropped = 0;
  for (const entry of ranked) {
    if (items.length >= limit) {
      dropped += 1;
      continue;
    }
    // 和记忆预算同一条规矩：装不下就整条跳过，但第一条永远放行。
    if (tokenBudget > 0 && usedTokens + entry.tokens > tokenBudget && items.length > 0) {
      dropped += 1;
      continue;
    }
    usedTokens += entry.tokens;
    items.push(entry);
  }
  return { items, usedTokens, dropped };
}

/**
 * 从问句里认出「在问谁（账号）」。
 *
 * 5–12 位连续数字当作平台账号（QQ 号）。账号比昵称准 —— 昵称会改、会重名，
 * 所以检索优先按它匹配 `participantRefs.externalId`，名字只作兜底。
 */
export function parseEventParticipantIdQuery(query: string): string | null {
  const match = /(?<!\d)(\d{5,12})(?!\d)/u.exec(query.normalize("NFKC"));
  return match?.[1] ?? null;
}

/** 从结构化引用里取出所有外部账号 id。引用是 JSON 列，读坏了就当没有。 */
function externalIdsOf(event: EventCandidate): string[] {
  const refs = event.participantRefs;
  if (!Array.isArray(refs)) return [];
  const ids: string[] = [];
  for (const ref of refs) {
    if (!ref || typeof ref !== "object") continue;
    const record = ref as Record<string, unknown>;
    if (record.kind !== "external") continue;
    const id = typeof record.externalId === "string" ? record.externalId.trim() : "";
    if (id) ids.push(id);
  }
  return ids;
}

/**
 * 从问句里认出「在问谁」。
 *
 * 只认确定的说法（和/跟/与某人…、某人的事、第一次见某人），认不出就返回 null；
 * 不猜 —— 猜错人比不按人过滤更糟。返回的是显示名片段，和忆泡的 participants 比对。
 *
 * 允许单字名字（「曦」）：QQ 群里单字昵称很常见，卡到 2 字等于这个人永远搜不到。
 * 但单字误命中率高（「和好了一起吃饭」→「好」），所以调用方必须再用账号确认一次
 * —— 见 `selectEventsForPrompt` 的 `participantIds`。
 */
export function parseEventParticipantQuery(query: string): string | null {
  const text = query.normalize("NFKC").replace(/\s+/gu, "");
  const stop = new Set(["我", "你", "她", "他", "它", "我们", "你们", "大家", "自己", "别人", "好", "他"]);
  const patterns = [
    /(?:第一次|首次|头一回|初次)(?:见到|遇到|见|和|跟|与)([^\s，。？！,!?]{1,12}?)(?=是什么时候|什么时候|是哪天|哪一天|哪年|见面|聊天|说话|一起|出去|吃饭|玩|的|[，。？！,!?]|$)/u,
    /(?:和|跟|与)([^\s，。？！,!?]{1,12}?)(?:的|一起|聊|说|去|见过|见面|吃饭|玩|吵架|经历|事情|那天|那次|约定)/u,
    /([^\s，。？！,!?]{1,12})的(?:事|经历|回忆|那次|约定)/u,
  ];
  for (const pattern of patterns) {
    const name = pattern.exec(text)?.[1]?.trim();
    if (!name) continue;
    // 去掉「小明都」「小明也」这类语气尾巴。
    const cleaned = name.replace(/(?:都|也|还|又|就|们)+$/u, "");
    if (cleaned.length >= 1 && !stop.has(cleaned)) return cleaned;
  }
  return null;
}

export function selectEventsForPrompt<T extends EventCandidate>(
  query: string,
  events: T[],
  options: EventSelectionOptions = {},
): SelectedEvents<T> {
  const now = options.now ?? new Date();
  const timeZone = options.timeZone ?? "Asia/Shanghai";
  const tokenBudget = options.tokenBudget && options.tokenBudget > 0 ? options.tokenBudget : EVENT_TOKEN_BUDGET_DEFAULT;
  const limit = options.limit && options.limit > 0 ? options.limit : EVENT_LIMIT_DEFAULT;
  const range = parseEventTimeRange(query, now, timeZone);
  const wantsFirst = /第一次|首次|最开始|初次|头一回/u.test(query);
  const wantsLatest = /最近一次|上一次|上回|上次|最后一次/u.test(query);

  const inRange = (items: T[]) => range
    ? items.filter((event) => event.occurredAt.getTime() >= range.start.getTime()
      && event.occurredAt.getTime() < range.end.getTime())
    : items;
  const ranked = (items: T[]) => items.map((event) => {
    const { score, tokens } = scoreByKeywords(query, event);
    return { ...event, relevanceScore: score, tokens };
  });
  const timeOrdered = (items: Array<RankedEvent<T>>, direction: "first" | "latest") =>
    [...items].sort((left, right) => direction === "first"
      ? left.occurredAt.getTime() - right.occurredAt.getTime()
      : right.occurredAt.getTime() - left.occurredAt.getTime());

  // 明确问「第一次 / 上一次」时，不让普通相关度排序盖过时间意图。
  const timeIntent = wantsFirst ? "first" : wantsLatest ? "latest" : null;
  // 单数时间问题只给最匹配的一次；普通人物回顾仍保留调用方指定的多条上限。
  const selectionLimit = timeIntent ? 1 : limit;

  // 先按账号找：问句里出现 5–12 位数字就当平台账号，直接匹配 participantRefs.externalId。
  const participantId = parseEventParticipantIdQuery(query);
  if (participantId) {
    const byId = inRange(events.filter((event) => externalIdsOf(event).includes(participantId)));
    if (byId.length > 0) {
      const direction = timeIntent ?? "latest";
      const ordered = timeOrdered(ranked(byId), direction);
      return { ...applyBudget(ordered, tokenBudget, selectionLimit), range, mode: direction === "first" ? "first" : direction === "latest" && timeIntent ? "latest" : "participant" };
    }
  }

  /**
   * 「关于某个人的事」与「第一次见到某人」按参与者过滤。
   * 昵称负责找到入口，账号负责兜住改名；结果再按时间意图排序。
   */
  const participant = parseEventParticipantQuery(query);
  const wantedIds = new Set(options.participantIds ?? []);
  if (participant && (participant.length >= 2 || wantedIds.size > 0)) {
    const wanted = normalize(participant);
    const byName = events.filter((event) => event.participants.some((person) => {
      const name = normalize(person);
      return name.length >= 2 && (name.includes(wanted) || wanted.includes(name));
    }));
    const byAccount = wantedIds.size
      ? events.filter((event) => externalIdsOf(event).some((id) => wantedIds.has(id)))
      : [];
    const matched = inRange([...new Map(
      [...byName, ...byAccount].map((event) => [event.id, event]),
    ).values()]);
    if (matched.length > 0) {
      const direction = timeIntent ?? "latest";
      const ordered = timeOrdered(ranked(matched), direction);
      return {
        ...applyBudget(ordered, tokenBudget, selectionLimit),
        range,
        mode: direction === "first" ? "first" : timeIntent === "latest" ? "latest" : "participant",
      };
    }
  }

  let candidates = ranked(inRange(events));
  if (timeIntent) {
    // 有主题词时先筛主题，再按时间取首/末；没有主题命中就只按时间，不编造筛选条件。
    const matching = candidates.filter((event) => event.relevanceScore > 0);
    if (matching.length) candidates = matching;
    const ordered = timeOrdered(candidates, timeIntent);
    const selected = applyBudget(ordered, tokenBudget, selectionLimit);
    return {
      ...selected,
      items: [...selected.items].sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime()),
      range,
      mode: timeIntent,
    };
  }

  if (range) {
    // 短区间（一天/两天）是时间线，按发生时间正序；月/年等宽区间先选相关事件，
    // 没有关键词命中时取区间内最近的几件事，避免总是把年初的记录塞给用户。
    const broadRange = range.end.getTime() - range.start.getTime() > 2 * 24 * 60 * 60 * 1000;
    if (broadRange) {
      const matching = candidates.filter((event) => event.relevanceScore > 0);
      const ordered = matching.length
        ? [...matching].sort((left, right) =>
            right.relevanceScore - left.relevanceScore || right.occurredAt.getTime() - left.occurredAt.getTime(),
          )
        : timeOrdered(candidates, "latest");
      const selected = applyBudget(ordered, tokenBudget, selectionLimit);
      return {
        ...selected,
        items: [...selected.items].sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime()),
        range,
        mode: "range",
      };
    }

    const ordered = [...candidates].sort((left, right) =>
      left.occurredAt.getTime() - right.occurredAt.getTime() || right.relevanceScore - left.relevanceScore,
    );
    return { ...applyBudget(ordered, tokenBudget, selectionLimit), range, mode: "range" };
  }

  candidates = candidates
    .filter((event) => event.relevanceScore > 0)
    .sort((left, right) =>
      right.relevanceScore - left.relevanceScore || right.occurredAt.getTime() - left.occurredAt.getTime(),
    );
  return { ...applyBudget(candidates, tokenBudget, selectionLimit), range: null, mode: "keyword" };
}

function positive(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

export type RecentEventSelection<T> = {
  items: Array<RankedEvent<T>>;
  usedTokens: number;
  /** 实际生效的天数；0 表示没开。 */
  days: number;
};

/**
 * 取最近 N 天的事，和问句无关。
 *
 * `excludeIds` 用来躲开「这一轮已经按关键词挑中的」——同一件事在一轮里出现两次，
 * 模型会以为那件事发生了两遍。
 */
export function selectRecentEvents<T extends EventCandidate>(
  events: T[],
  options: {
    now?: Date;
    days?: number;
    limit?: number;
    tokenBudget?: number;
    excludeIds?: Set<string>;
  } = {},
): RecentEventSelection<T> {
  const days = options.days && options.days > 0 ? Math.round(options.days) : EVENT_RECENT_DAYS_DEFAULT;
  const limit = options.limit && options.limit > 0 ? options.limit : EVENT_RECENT_LIMIT_DEFAULT;
  const tokenBudget = options.tokenBudget && options.tokenBudget > 0 ? options.tokenBudget : EVENT_RECENT_TOKEN_BUDGET;
  if (days <= 0) return { items: [], usedTokens: 0, days: 0 };

  const now = options.now ?? new Date();
  const since = now.getTime() - days * 24 * 60 * 60 * 1000;
  const excluded = options.excludeIds ?? new Set<string>();
  const ranked = events
    .filter((event) => !excluded.has(event.id))
    .filter((event) => {
      const at = event.occurredAt.getTime();
      return at >= since && at <= now.getTime();
    })
    // 最近的在前：越新的事越容易被接上话。
    .sort((left, right) => right.occurredAt.getTime() - left.occurredAt.getTime())
    .map((event) => ({ ...event, relevanceScore: 0, tokens: estimateTokens(eventText(event)) }));

  const selected = applyBudget(ranked, tokenBudget, limit);
  return { items: selected.items, usedTokens: selected.usedTokens, days };
}

/** 近期忆泡的开关：0（或没配）= 不带。上限 14 天，防止一句配置把整段历史塞进提示词。 */
export function resolveEventRecentDays(modelConfig: unknown): number {
  const record = modelConfig && typeof modelConfig === "object" ? modelConfig as Record<string, unknown> : {};
  const raw = record.eventRecentDays;
  const days = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(days) || days <= 0) return 0;
  return Math.min(14, Math.round(days));
}

/** 忆泡预算单独一份：问「那天发生了什么」时它才是主角，不该和记忆条目抢同一个池子。 */
export function resolveEventTokenBudget(modelConfig: unknown): number {
  const record = modelConfig && typeof modelConfig === "object" ? modelConfig as Record<string, unknown> : {};
  return positive(record.eventTokenBudget) || EVENT_TOKEN_BUDGET_DEFAULT;
}

export function resolveEventItemLimit(modelConfig: unknown): number {
  const record = modelConfig && typeof modelConfig === "object" ? modelConfig as Record<string, unknown> : {};
  return positive(record.eventItemLimit) || EVENT_LIMIT_DEFAULT;
}
