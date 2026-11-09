/**
 * 好友主动联系的确定性安全闸门。
 *
 * 这里只判断「现在是否允许联系这位好友」，不生成话题、不挑群、不发送消息。
 * 主动联系授权与 friendChatPolicy 分离：前者是好友级主动联系许可，
 * 后者仍然只控制她是否接收/参与这个人的普通交流。
 */

export type SocialContactStage = "STRANGER" | "ACQUAINTANCE" | "FRIEND" | "CLOSE_FRIEND";
export type SocialContactStatus = "NORMAL" | "DISTANT" | "CONFLICT" | "REPAIRING" | "UNOBSERVED";
export type SocialContactIdentityKind = "UNKNOWN" | "HUMAN" | "AI";
export type SocialContactChatPolicy = "DEFAULT" | "ALLOW" | "BLOCK";
export type SocialContactGroupMode = "mention" | "ambient" | "all";

export type SocialProactiveContactGateInput = {
  /** 独立的好友级主动联系许可；不能由 friendChatPolicy 推导。 */
  proactiveContactEnabled: boolean;
  relationshipStage: SocialContactStage | null;
  relationshipStatus: SocialContactStatus | null;
  identityKind: SocialContactIdentityKind;
  friendChatPolicy: SocialContactChatPolicy;
  /** 目标与角色当前是否仍绑定到可用 QQ OneBot 渠道。 */
  channelAvailable: boolean;
  /** 目标是否在至少一个当前有效绑定的共同群里。 */
  hasCommonGroup: boolean;
  /** 选中的共同群是否仍允许机器人主动发言。 */
  groupMode: SocialContactGroupMode | null;
  /** 发送前通过 OneBot 实时查询确认目标仍在群内。 */
  targetMemberVerified: boolean;
  /** 目标是 AI 时，当前群会话连续 AI 轮数。 */
  targetIsAi: boolean;
  consecutiveAiRounds: number;
  maxConsecutiveAiRounds: number;
  /** 当前角色今天已主动联系好友的次数（不是群冷场开口数）。 */
  sentToday: number;
  dailyLimit: number;
  /** 当前好友上一次成功主动联系的时间。 */
  lastContactAt: Date | null;
  cooldownMs: number;
  now: Date;
};

export type SocialProactiveContactGateResult = {
  allowed: boolean;
  reason:
    | "not_authorized"
    | "relationship_not_close"
    | "relationship_not_healthy"
    | "friend_blocked"
    | "ai_friend_not_allowed"
    | "channel_unavailable"
    | "no_common_group"
    | "group_mode_forbids"
    | "target_not_verified"
    | "ai_dialogue_limit"
    | "daily_limit"
    | "friend_cooldown"
    | "ok";
};

/**
 * 所有条件均 fail closed。任何未知、缺失或过期的渠道事实都不能被当作允许发送。
 * 顺序刻意固定：先报告授权/关系/屏蔽，再报告渠道和频率限制。
 */
export function evaluateSocialProactiveContactGate(
  input: SocialProactiveContactGateInput,
): SocialProactiveContactGateResult {
  if (!input.proactiveContactEnabled) return { allowed: false, reason: "not_authorized" };

  if (input.relationshipStage !== "FRIEND" && input.relationshipStage !== "CLOSE_FRIEND") {
    return { allowed: false, reason: "relationship_not_close" };
  }
  if (input.relationshipStatus !== "NORMAL") {
    return { allowed: false, reason: "relationship_not_healthy" };
  }
  if (input.friendChatPolicy === "BLOCK") {
    return { allowed: false, reason: "friend_blocked" };
  }
  // AI 默认不接话；只有用户明确允许交流后，才允许把它作为主动联系对象。
  if (input.identityKind === "AI" && input.friendChatPolicy !== "ALLOW") {
    return { allowed: false, reason: "ai_friend_not_allowed" };
  }

  if (!input.channelAvailable) return { allowed: false, reason: "channel_unavailable" };
  if (!input.hasCommonGroup) return { allowed: false, reason: "no_common_group" };
  // mention 档代表这个群明确选择「只在被 @ 时回复」，主动 @ 别人也属于主动发言。
  if (input.groupMode !== "ambient" && input.groupMode !== "all") {
    return { allowed: false, reason: "group_mode_forbids" };
  }
  if (!input.targetMemberVerified) return { allowed: false, reason: "target_not_verified" };

  if (
    input.targetIsAi
    && input.maxConsecutiveAiRounds >= 0
    && input.consecutiveAiRounds >= input.maxConsecutiveAiRounds
  ) {
    return { allowed: false, reason: "ai_dialogue_limit" };
  }
  if (input.dailyLimit <= 0 || input.sentToday >= input.dailyLimit) {
    return { allowed: false, reason: "daily_limit" };
  }
  if (
    input.lastContactAt
    && input.cooldownMs > 0
    && input.now.getTime() - input.lastContactAt.getTime() < input.cooldownMs
  ) {
    return { allowed: false, reason: "friend_cooldown" };
  }

  return { allowed: true, reason: "ok" };
}
