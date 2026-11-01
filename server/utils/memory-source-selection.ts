/**
 * 一个周期里该把哪些原始消息交给模型。
 *
 * 以前是「整个记忆范围按时间取最早 125 条 + 最晚 125 条」。一个群一天几十条，
 * 8 天周期轻松上百条，私聊就被挤出了窗口 —— 结果是总结里全是群里的闲话，
 * 她跟你聊过什么反而没进提示词。
 *
 * 现在按会话配额：每个会话先保住自己最新的一条，再在预算内按时间填满。
 * 这样水群再吵也不会让私聊整段消失，同时总量仍有上限（快照来源行数不能无限涨）。
 */

export type PeriodSourceMessageRef = {
  id: string;
  conversationId: string;
  occurredAt: Date;
  /**
   * 会话来源标签（`QQ群 12345678` / `私聊` / `本地对话`）。
   * 一对一（私聊、本地）的锚点优先级高于群聊：群再多，也不能把私聊整个挤出预算。
   */
  origin?: string;
};

/** 一个周期的来源消息总量上限，同时也是快照 sources 的行数上限。 */
export const PERIOD_SOURCE_BUDGET = 250;
/** 单个会话最多取多少条：够看出这段经历，又不至于让一个群占满预算。 */
export const PER_CONVERSATION_SOURCE_WINDOW = 80;

function compareMessages(a: PeriodSourceMessageRef, b: PeriodSourceMessageRef): number {
  return a.occurredAt.getTime() - b.occurredAt.getTime() || a.id.localeCompare(b.id);
}

/** 群聊的来源标签都以 `QQ群 ` 开头；一对一（私聊/本地）返回 false。 */
function isGroupOrigin(origin: string | undefined): boolean {
  return origin != null && origin.startsWith("QQ群 ");
}

export function selectPeriodSourceMessages<T extends PeriodSourceMessageRef>(
  messages: readonly T[],
  options: { budget?: number; perConversation?: number } = {},
): T[] {
  const budget = Math.max(1, Math.trunc(options.budget ?? PERIOD_SOURCE_BUDGET));
  const perConversation = Math.max(1, Math.trunc(options.perConversation ?? PER_CONVERSATION_SOURCE_WINDOW));

  // 补取窗口时同一行可能出现在两次查询里，按 id 去重。
  const unique = new Map<string, T>();
  for (const message of messages) {
    if (!unique.has(message.id)) unique.set(message.id, message);
  }

  const byConversation = new Map<string, T[]>();
  for (const message of unique.values()) {
    const bucket = byConversation.get(message.conversationId);
    if (bucket) bucket.push(message);
    else byConversation.set(message.conversationId, [message]);
  }

  const anchors: T[] = [];
  const rest: T[] = [];
  for (const bucket of byConversation.values()) {
    bucket.sort(compareMessages);
    const window = bucket.slice(-perConversation);
    const anchor = window.pop();
    if (anchor) anchors.push(anchor);
    rest.push(...window);
  }

  const kept = new Map<string, T>();
  // 每个会话的最新一条先按时间排，预算不够时保住最近在说话的那几个会话。
  // 一对一（私聊/本地）的锚点永远排在群聊前面：群再多也不能把私聊挤掉。
  anchors.sort((a, b) => {
    const aGroup = isGroupOrigin(a.origin) ? 1 : 0;
    const bGroup = isGroupOrigin(b.origin) ? 1 : 0;
    if (aGroup !== bGroup) return aGroup - bGroup;
    return compareMessages(b, a);
  });
  for (const message of anchors) {
    if (kept.size >= budget) break;
    kept.set(message.id, message);
  }
  rest.sort((a, b) => compareMessages(b, a));
  for (const message of rest) {
    if (kept.size >= budget) break;
    kept.set(message.id, message);
  }

  return [...kept.values()].sort(compareMessages);
}
