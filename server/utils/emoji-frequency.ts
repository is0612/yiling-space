/**
 * 表情的「说话额度」：N 分钟内最多贴 N 张。
 *
 * 原来是一个冷却常量（上一条贴过表情，之后 10 分钟（后来 4 分钟）都不许再贴）。
 * 冷却的问题是**跟聊天密度无关**：群里刷得快，4 分钟能过掉二十条消息；
 * 一对一聊得慢，4 分钟可能只过两条。用户要的是「一段时间里能贴几张」，
 * 所以改成滑动窗口计数：`每 windowMinutes 分钟最多 perWindow 张`。
 *
 * 内置表情（face 段）与表情包（image 段）共用这一个额度 —— 它们是同一件事
 * （「她贴了张图」），分开计数等于把上限翻倍。
 */

export type EmojiFrequency = {
  /** 窗口长度（分钟）。 */
  windowMinutes: number;
  /** 窗口内最多贴几次。 */
  perWindow: number;
};

/**
 * 默认每 10 分钟 3 张。
 *
 * 10 分钟是群聊里「一轮热闹」的尺度，3 张大约等于「热聊时每三四句贴一张」；
 * 比单个 4 分钟冷却宽，因为它是「一段时间的总量」而不是「两次之间的硬间隔」。
 */
export const EMOJI_FREQUENCY_DEFAULTS: EmojiFrequency = { windowMinutes: 10, perWindow: 3 };

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(Math.round(value), max));
}

/** 从角色 `modelConfig` 读额度；缺省或脏值都夹到安全范围，不让一次手改把上限弄成 1000。 */
export function resolveEmojiFrequency(modelConfig: unknown): EmojiFrequency {
  const config = asRecord(modelConfig);
  return {
    windowMinutes: clampInt(config.emojiWindowMinutes, EMOJI_FREQUENCY_DEFAULTS.windowMinutes, 1, 1440),
    perWindow: clampInt(config.emojiPerWindow, EMOJI_FREQUENCY_DEFAULTS.perWindow, 1, 20),
  };
}

/** 这条消息贴过表情吗（内置表情或表情包都算）。metadata 是落库时写的那份。 */
export function hasEmojiMark(metadata: unknown): boolean {
  const record = asRecord(metadata);
  if (typeof record.stickerId === "string" && record.stickerId) return true;
  return Array.isArray(record.faceIds) && record.faceIds.length > 0;
}

/**
 * 额度用完了吗。
 *
 * `history` 只需传同一个会话（群/私聊）的助手消息 —— 额度按会话分别算：
 * 在 A 群贴过三张，不该让 B 群跟着闭嘴。
 */
export function isEmojiBudgetSpent(
  history: readonly { occurredAt: Date; metadata: unknown }[],
  now: Date,
  frequency: EmojiFrequency = EMOJI_FREQUENCY_DEFAULTS,
): boolean {
  const since = now.getTime() - frequency.windowMinutes * 60_000;
  let used = 0;
  for (const message of history) {
    if (message.occurredAt.getTime() < since) continue;
    if (!hasEmojiMark(message.metadata)) continue;
    used += 1;
    if (used >= frequency.perWindow) return true;
  }
  return false;
}
