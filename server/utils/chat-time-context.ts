/**
 * 提示词里的「现在」。
 *
 * 模型不会自己算日期：「前天」「上周」「上个月」这类相对说法必须由服务端换算成
 * 带时区的绝对时间再给它，否则它只能猜。这里只做「把当前时刻渲染成几段可读文本」，
 * 不掺业务判断，纯函数方便测试。
 */

export const CHAT_TIME_ZONE_DEFAULT = "Asia/Shanghai";

export type ChatTimeContext = {
  /** IANA 时区名，例如 Asia/Shanghai */
  timeZone: string;
  /** 当地时间：2026-10-31 14:55:33 */
  local: string;
  /** 星期：周六 */
  weekday: string;
  /** 同一时刻的 UTC ISO，给「绝对时间」一个无歧义锚点 */
  utc: string;
};

/**
 * 角色设置里的时区可能是空的、也可能是别人手填的坏值；
 * 一律回落到默认时区，不让一个坏字符串把整轮回复打成 500。
 */
export function resolveChatTimeZone(value: unknown): string {
  if (typeof value !== "string") return CHAT_TIME_ZONE_DEFAULT;
  const zone = value.trim();
  if (!zone) return CHAT_TIME_ZONE_DEFAULT;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return CHAT_TIME_ZONE_DEFAULT;
  }
}

export function buildChatTimeContext(now: Date, timeZone: string): ChatTimeContext {
  const zone = resolveChatTimeZone(timeZone);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const pick = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  return {
    timeZone: zone,
    local: `${pick("year")}-${pick("month")}-${pick("day")} ${pick("hour")}:${pick("minute")}:${pick("second")}`,
    weekday: new Intl.DateTimeFormat("zh-CN", { timeZone: zone, weekday: "short" }).format(now),
    utc: now.toISOString(),
  };
}
