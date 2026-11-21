/**
 * 上下文装配的**计划**：这一轮要放哪几类来源、各自多少额度、为什么放。
 *
 * 现在只是「描述」而不是「驱动」：真正的查询、筛选、渲染仍在 `chat.post.ts` 与
 * `pipeline.ts` 里，计划算出来只为了写进回合详情（`contextPlan`），用来回答
 * 「配了 1800 token 的记忆预算，这轮实际用上多少」。
 *
 * 纯函数、不查库、不读时钟；输入全部显式传入，方便固定样例回归。
 * 顺序写死在这里（最近对话 → 记忆 → 快照 → 忆泡 → 原文 → 跨窗口 → 知识），
 * 「最近几天」的背景忆泡（`eventRecentDays` 打开时）计入 event 段的 used，不单独成段。
 * 不提供重排入口 —— 重排会改变模型对信息权重的感受，那是行为变更而非配置。
 */

export const CONTEXT_SOURCE_ORDER = [
  "recentMessages", "memory", "snapshot", "event", "rawMessage", "crossChannel", "knowledge",
] as const;

export type ContextSource = (typeof CONTEXT_SOURCE_ORDER)[number];

export type ContextReason =
  | "always"
  | "question_has_date"
  | "question_has_topic"
  | "keyword_hit"
  | "owner_cross_channel";

export type ContextPlanSegment = {
  source: ContextSource;
  /** token 上限；0 表示不限（例如最近对话按条数控）。 */
  budget: number;
  /** 条数上限；0 表示不限。 */
  limit: number;
  reason: ContextReason;
  /** 允许为空：为空时记 used=0，不视为异常。 */
  optional: boolean;
};

export type ContextPlan = {
  surface: "desktop" | "private" | "group";
  totalBudget: number;
  segments: ContextPlanSegment[];
};

export type ContextPlanUsage = ContextPlan & {
  segments: Array<ContextPlanSegment & { used: number; items: number }>;
};

export type ContextPlanInput = {
  surface: "desktop" | "private" | "group";
  isOwner: boolean;
  /** 问句形态：指某一天、指向某人/话题，或者都不是。 */
  questionKind: "date" | "topic" | "none";
  limits: {
    recentMessages: number;
    memoryItems: number;
    memoryTokens: number;
    snapshotItems: number;
    snapshotTokens: number;
    eventItems: number;
    eventTokens: number;
    rawMessageItems: number;
    rawMessageTokens: number;
  };
  /** 知识库接进来之后才有意义；P0 默认 false。 */
  hasKnowledgeHit?: boolean;
};

export function planContextTurn(input: ContextPlanInput): ContextPlan {
  const { limits, questionKind } = input;
  const segments: ContextPlanSegment[] = [
    { source: "recentMessages", budget: 0, limit: limits.recentMessages, reason: "always", optional: false },
    { source: "memory", budget: limits.memoryTokens, limit: limits.memoryItems, reason: "always", optional: true },
    { source: "snapshot", budget: limits.snapshotTokens, limit: limits.snapshotItems, reason: "always", optional: true },
    {
      source: "event",
      budget: limits.eventTokens,
      limit: limits.eventItems,
      reason: questionKind === "date" ? "question_has_date" : questionKind === "topic" ? "question_has_topic" : "always",
      optional: true,
    },
  ];
  // 原文兜底只在问句指向某一天时查，别的时候查了也用不上。
  if (questionKind === "date") {
    segments.push({ source: "rawMessage", budget: limits.rawMessageTokens, limit: limits.rawMessageItems, reason: "question_has_date", optional: true });
  }
  // 跨窗口旁路只有主人私聊这一条。
  if (input.surface === "private" && input.isOwner) {
    segments.push({ source: "crossChannel", budget: 600, limit: 16, reason: "owner_cross_channel", optional: true });
  }
  if (input.hasKnowledgeHit) {
    segments.push({ source: "knowledge", budget: 0, limit: 0, reason: "keyword_hit", optional: true });
  }
  return {
    surface: input.surface,
    totalBudget: segments.reduce((sum, segment) => sum + Math.max(0, segment.budget), 0),
    segments,
  };
}

/** 用真实装配结果回填 `used` / `items`；计划里没有的段不会凭空出现。 */
export function fillContextPlanUsage(
  plan: ContextPlan,
  used: Partial<Record<ContextSource, { used: number; items: number }>>,
): ContextPlanUsage {
  return {
    surface: plan.surface,
    totalBudget: plan.totalBudget,
    segments: plan.segments.map(segment => {
      const actual = used[segment.source];
      return { ...segment, used: actual?.used ?? 0, items: actual?.items ?? 0 };
    }),
  };
}
