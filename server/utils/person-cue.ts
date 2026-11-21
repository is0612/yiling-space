/**
 * 人物线索：这一轮谁在说话，就看看「我和 TA 之间发生过什么」。
 *
 * 群聊里最常见的情况是：有人随口提起「上次那个比赛」，而共同经历只存在于
 * 她和这个人的忆泡里 —— 靠问句关键词检索不到，因为那句话本身没有任何实体词。
 *
 * 这里只回答一个问题：**当前这批发言的人里，有没有一条与 TA 相关、又和本轮话题沾边的经历**。
 * 最多一条，且必须和已经选中的忆泡去重；找不到就返回 null，不硬凑。
 *
 * 边界：
 *   - 只在群聊里用，且由调用方显式开启（默认关）。
 *   - 只看**当前群**会话里的忆泡（调用方传进来的候选已经是本群范围）。
 *   - 认人只用账号（`participantRefs.externalId`），不靠昵称：改名不影响。
 *   - 账号出现在参与者里 ≠ 整件事都是 TA 做的；提示词那边保留事件原文，不要简化成「这个人的事实」。
 */

import type { EventCandidate } from "./memory-event-retrieval";
import { extractMemoryAssistantSearchTerms } from "./memory-retrieval";

export type PersonCueEvent = EventCandidate & { memoryScopeId?: string };

export type PersonCueResult<T extends PersonCueEvent> = {
  event: T | null;
  reason: "picked" | "no_speaker" | "no_match";
};

/** 从结构化引用里取外部账号；读坏了就当没有这条。 */
function externalIdsOf(event: PersonCueEvent): string[] {
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
 * 选一条「和当前说话人有关」的忆泡。纯函数，查库由调用方完成。
 *
 * `query` 用来在有多个候选时挑和本轮话题更沾边的；一个都不沾边时，
 * 仍允许取**最近一条**共同经历 —— 那是「你俩认识」这个事实本身，不是编造。
 */
export function pickPersonCueEvent<T extends PersonCueEvent>(input: {
  query: string;
  events: readonly T[];
  speakerIds: readonly string[];
  excludeIds?: ReadonlySet<string>;
  now?: Date;
  timeZone?: string;
}): PersonCueResult<T> {
  const speakers = new Set(input.speakerIds.map(id => id.trim()).filter(Boolean));
  if (!speakers.size) return { event: null, reason: "no_speaker" };
  const exclude = input.excludeIds ?? new Set<string>();
  const candidates = input.events.filter(event => {
    if (exclude.has(event.id)) return false;
    return externalIdsOf(event).some(id => speakers.has(id));
  });
  if (!candidates.length) return { event: null, reason: "no_match" };

  // 自己算相关度，不走「按时间取首/取末」那套：线索要的是「沾边」，
  // 而不是「最近一次」。同分时取更新的那条。
  const terms = extractMemoryAssistantSearchTerms(input.query, 20).filter((term) => term.length >= 2);
  const score = (event: T) => {
    const text = [event.title, event.detail, ...(Array.isArray(event.keywords) ? event.keywords : [])].join(" ");
    return terms.reduce((sum, term) => (text.includes(term) ? sum + 1 : sum), 0);
  };
  const sorted = [...candidates].sort((left, right) => {
    const delta = score(right) - score(left);
    return delta !== 0 ? delta : right.occurredAt.getTime() - left.occurredAt.getTime();
  });
  const best = sorted[0];
  return best ? { event: best, reason: "picked" } : { event: null, reason: "no_match" };
}
