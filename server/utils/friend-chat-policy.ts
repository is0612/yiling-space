export type FriendIdentityKind = "UNKNOWN" | "HUMAN" | "AI";
export type FriendChatPolicy = "DEFAULT" | "ALLOW" | "BLOCK";

/** 连续只包含 AI 发言的群聊轮数上限；真人参与后由适配器清零。 */
export const MAX_CONSECUTIVE_AI_ROUNDS = 3;

/**
 * 身份与交流权限分开判断：
 * - BLOCK 永远拒绝；
 * - ALLOW 明确加入该角色的 AI 朋友名单；
 * - DEFAULT 下 AI 不接话，真人和未知对象保留原行为。
 */
export function shouldBlockFriendSpeaker(
  identityKind: FriendIdentityKind,
  chatPolicy: FriendChatPolicy,
): boolean {
  if (chatPolicy === "BLOCK") return true;
  if (chatPolicy === "ALLOW") return false;
  return identityKind === "AI";
}

/** 一轮只有在每条消息都来自已标记 AI 时，才计入连续 AI 对话保护。 */
export function isAiOnlyGroupRound(identityKinds: readonly FriendIdentityKind[]): boolean {
  return identityKinds.length > 0 && identityKinds.every((kind) => kind === "AI");
}

/**
 * 计算一轮结束后的连续 AI-only 轮数。
 *
 * 只有明确确认的真人参与，才能打断 AI 连聊计数；UNKNOWN 既不能冒充真人清零，
 * 也不能冒充 AI 增加轮数。这样未分类的机器人不会轻易把已有的保护计数洗掉。
 */
export function nextConsecutiveAiRounds(
  current: number,
  identityKinds: readonly FriendIdentityKind[],
): number {
  const previous = Number.isFinite(current) ? Math.max(0, Math.floor(current)) : 0;
  if (identityKinds.some((kind) => kind === "HUMAN")) return 0;
  if (isAiOnlyGroupRound(identityKinds)) return previous + 1;
  return previous;
}

/** 达到连续 AI 轮数上限后暂停；后续真人参与会将计数清零。 */
export function shouldPauseAiOnlyRound(consecutiveAiRounds: number): boolean {
  return Number.isFinite(consecutiveAiRounds)
    && consecutiveAiRounds >= MAX_CONSECUTIVE_AI_ROUNDS;
}
