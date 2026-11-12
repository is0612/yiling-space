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

/** 同一时刻在角色时区里的日期与时刻，只算一次格式化。 */
function localParts(now: Date, zone: string): { date: string; time: string } {
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
    date: `${pick("year")}-${pick("month")}-${pick("day")}`,
    time: `${pick("hour")}:${pick("minute")}:${pick("second")}`,
  };
}

export function buildChatTimeContext(now: Date, timeZone: string): ChatTimeContext {
  const zone = resolveChatTimeZone(timeZone);
  const parts = localParts(now, zone);
  return {
    timeZone: zone,
    local: `${parts.date} ${parts.time}`,
    weekday: new Intl.DateTimeFormat("zh-CN", { timeZone: zone, weekday: "short" }).format(now),
    utc: now.toISOString(),
  };
}

/**
 * 历史时间戳进提示词时一律换成本地时间。
 *
 * 2026-11-12 凌晨 00:38 那轮踩过：`now.local` 是北京时间 11-12，而消息的 `occurredAt`
 * 是 UTC ISO「2026-11-11T16:38:00.000Z」，提示词又要求「相对日期只看 now.local」。
 * 模型拿 ISO 的日期部分一比，就把两分钟前说的话判成「昨天」——UTC+8 下凡是本地
 * 00:00–07:59 说的话，UTC 日期都在前一天，而那正好是深夜聊天的时间。
 *
 * 两个表示同时给，模型一定挑错那一个。所以进提示词的时间只留本地这一种，
 * 不认识的输入返回空串，让调用方整条字段省略，而不是塞一个坏值。
 */
export function formatLocalTimestamp(
  value: string | Date | null | undefined,
  timeZone: string,
): string {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  try {
    const parts = localParts(date, resolveChatTimeZone(timeZone));
    return `${parts.date} ${parts.time}`;
  } catch {
    return "";
  }
}
