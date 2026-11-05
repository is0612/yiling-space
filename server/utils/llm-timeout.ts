/**
 * 模型请求超时的解析。
 *
 * 同一个 `LLM_TIMEOUT_MS` 以前被两拨完全不同的调用读：
 *
 * - **聊天**（网页 / QQ / B站 被动回复）：用户在等一句回复，超时久了就是「卡住不回」，
 *   60 秒已经嫌长；
 * - **后台任务**（忆泡分块抽取、快照、日记）：一次要等一整块，一块一百多条消息，
 *   思考型模型常常 60~120 秒 —— 60 秒会把它整块 abort 掉。
 *
 * 2026-11-05 的事故就是两者共用一个 60 秒的值：忆泡每块都超时、游标一步不动，
 * 而把值调大「救」忆泡，代价是聊天失败时要干等三分钟。现在拆成两个变量各管一头，
 * 旧的 `LLM_TIMEOUT_MS` 继续作为兜底 —— 老安装不改 `.env` 也不会突然变行为。
 */
export type LlmTimeoutKind = "chat" | "job";

/** 两个用途各自的默认值：聊天等一句回复，后台任务等一整块抽取。 */
export const DEFAULT_LLM_TIMEOUT_MS: Record<LlmTimeoutKind, number> = {
  chat: 60_000,
  job: 180_000,
};

/** 低于 5 秒连握手都不够，一定是配错了；上限 180 秒，超过就当「卡死」处理。 */
const MIN_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 180_000;

/** 专属变量优先，旧版共用的 `LLM_TIMEOUT_MS` 兜底。 */
const TIMEOUT_ENV_KEYS: Record<LlmTimeoutKind, string[]> = {
  chat: ["LLM_CHAT_TIMEOUT_MS", "LLM_TIMEOUT_MS"],
  job: ["LLM_JOB_TIMEOUT_MS", "LLM_TIMEOUT_MS"],
};

/**
 * 读出显式配置的超时；一个都没配（或都填坏了）返回 `null`。
 *
 * 返回 `null` 而不是直接给默认值：几个调用点的默认值并不一样（聊天 60 秒、
 * 忆泡 180 秒、裸文本调用 90 秒），在这里统一成一个数字会悄悄改掉它们的行为。
 */
export function readConfiguredLlmTimeoutMs(kind: LlmTimeoutKind): number | null {
  for (const key of TIMEOUT_ENV_KEYS[kind]) {
    const raw = Number(process.env[key]);
    if (Number.isInteger(raw) && raw >= MIN_TIMEOUT_MS && raw <= MAX_TIMEOUT_MS) return raw;
  }
  return null;
}
