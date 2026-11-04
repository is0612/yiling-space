/**
 * 把「前天」「上周三」「2026-10-25」这类说法解析成时间区间。
 *
 * 为什么放在服务端：模型自己不会算日期，而且它算出来的日期无法验证。
 * 这里只认明确、可验证的说法；认不出来就返回 null，宁可让检索退化成关键词，
 * 也不要猜一个区间 —— 猜错比不猜更糟（会让她把别人的事说成那天的）。
 */

export type EventTimeRange = {
  /** 区间起点（UTC 瞬间）。 */
  start: Date;
  /** 区间终点（不含）。 */
  end: Date;
  /** 给日志和调试看的中文标签，不参与计算。 */
  label: string;
};

type LocalParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

const TIME_ZONE_DEFAULT = "Asia/Shanghai";

const WEEKDAY_INDEX: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7,
};

/** 「上午」这类模糊时段，命中时把一天的区间收窄成几小时。 */
const PART_OF_DAY_HOURS: Array<{ pattern: RegExp; from: number; to: number; label: string }> = [
  { pattern: /凌晨/, from: 0, to: 6, label: "凌晨" },
  { pattern: /早上|早晨|清晨/, from: 6, to: 11, label: "早上" },
  { pattern: /上午/, from: 6, to: 12, label: "上午" },
  { pattern: /中午/, from: 11, to: 14, label: "中午" },
  { pattern: /下午/, from: 12, to: 18, label: "下午" },
  { pattern: /傍晚/, from: 17, to: 20, label: "傍晚" },
  { pattern: /晚上|夜里|夜间/, from: 18, to: 24, label: "晚上" },
  { pattern: /深夜/, from: 22, to: 24, label: "深夜" },
];

function readLocalParts(date: Date, timeZone: string): LocalParts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
  };
}

/** 某个瞬间在该时区的偏移（毫秒）。用「拆出来的本地时间」反推，两次迭代足够处理夏令时。 */
function zoneOffsetMs(date: Date, timeZone: string): number {
  const p = readLocalParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const actual = Math.floor(date.getTime() / 1000) * 1000;
  return asUtc - actual;
}

/** 把「该时区的某天某点」换成 UTC 瞬间。 */
export function zonedDateTime(
  year: number,
  month: number,
  day: number,
  hour: number,
  timeZone = TIME_ZONE_DEFAULT,
): Date {
  const target = Date.UTC(year, month - 1, day, hour, 0, 0);
  let guess = target;
  for (let index = 0; index < 2; index += 1) {
    guess = target - zoneOffsetMs(new Date(guess), timeZone);
  }
  return new Date(guess);
}

/** 当地日期的「第 N 天」加减，避免用 UTC 毫秒硬加导致跨月/夏令时错位。 */
function addLocalDays(parts: LocalParts, days: number): LocalParts {
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: 0,
    minute: 0,
    second: 0,
  };
}

/** 周一到周日的整数（1..7）。 */
function weekdayOf(parts: LocalParts): number {
  const index = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
  return index === 0 ? 7 : index;
}

function dayRange(parts: LocalParts, timeZone: string, label: string): EventTimeRange {
  const start = zonedDateTime(parts.year, parts.month, parts.day, 0, timeZone);
  const next = addLocalDays(parts, 1);
  const end = zonedDateTime(next.year, next.month, next.day, 0, timeZone);
  return { start, end, label };
}

function inCurrentYear(month: number, day: number, now: LocalParts): { year: number; month: number; day: number } {
  // 「10 月 25 日」没写年份时按当前年算；如果它比今天还晚出半年以上，多半指去年的。
  const candidate = new Date(Date.UTC(now.year, month - 1, day));
  const today = Date.UTC(now.year, now.month - 1, now.day);
  if (candidate.getTime() - today > 183 * 86_400_000) {
    return { year: now.year - 1, month, day };
  }
  return { year: now.year, month, day };
}

/** 月份偏移按「年月」运算，不用给某月的 31 号加减，避免月底溢出。 */
function addLocalMonths(parts: LocalParts, offset: number): { year: number; month: number } {
  const absoluteMonth = parts.year * 12 + parts.month - 1 + offset;
  return {
    year: Math.floor(absoluteMonth / 12),
    month: ((absoluteMonth % 12) + 12) % 12 + 1,
  };
}

function monthRange(year: number, month: number, timeZone: string, label: string): EventTimeRange | null {
  if (!Number.isInteger(year) || month < 1 || month > 12) return null;
  const next = addLocalMonths({ year, month, day: 1, hour: 0, minute: 0, second: 0 }, 1);
  return {
    start: zonedDateTime(year, month, 1, 0, timeZone),
    end: zonedDateTime(next.year, next.month, 1, 0, timeZone),
    label,
  };
}

function yearRange(year: number, timeZone: string, label: string): EventTimeRange {
  return {
    start: zonedDateTime(year, 1, 1, 0, timeZone),
    end: zonedDateTime(year + 1, 1, 1, 0, timeZone),
    label,
  };
}

function validDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

function narrowByPartOfDay(range: EventTimeRange, query: string, timeZone: string): EventTimeRange {
  const matched = PART_OF_DAY_HOURS.find((entry) => entry.pattern.test(query));
  if (!matched) return range;
  const startParts = readLocalParts(range.start, timeZone);
  const end = matched.to >= 24
    ? range.end
    : zonedDateTime(startParts.year, startParts.month, startParts.day, matched.to, timeZone);
  return {
    start: zonedDateTime(startParts.year, startParts.month, startParts.day, matched.from, timeZone),
    end,
    label: range.label + matched.label,
  };
}

/** 某个瞬间在角色时区里的日期键：2026-10-31。 */
export function localDayKey(date: Date, timeZone = TIME_ZONE_DEFAULT): string {
  const parts = readLocalParts(date, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

/** 某个瞬间在角色时区里的日期键 + 小时：用来给「每小时增量」做幂等键。 */
export function localDayHour(date: Date, timeZone = TIME_ZONE_DEFAULT): { dayKey: string; hour: number } {
  const parts = readLocalParts(date, timeZone);
  return { dayKey: localDayKey(date, timeZone), hour: parts.hour };
}

/** 某个日期键在角色时区里的整天区间（左闭右开）。 */
export function resolveDayWindow(dayKey: string, timeZone = TIME_ZONE_DEFAULT): { start: Date; end: Date } {
  const [year, month, day] = dayKey.split("-").map(Number);
  const start = zonedDateTime(year!, month!, day!, 0, timeZone);
  const next = new Date(Date.UTC(year!, month! - 1, day! + 1));
  const end = zonedDateTime(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, timeZone);
  return { start, end };
}

/**
 * 按天整理忆泡的窗口：**昨天**整天（按角色时区）。
 *
 * 为什么是昨天而不是今天：今天还没过完，事件会越补越多，一天里反复调模型；
 * 处理一整天既省调用，语义也清楚（「昨天做了什么」在第二天就有答案）。
 */
export function resolveDailyEventWindow(
  now: Date = new Date(),
  timeZone = TIME_ZONE_DEFAULT,
): { start: Date; end: Date; dayKey: string } {
  const today = readLocalParts(now, timeZone);
  const yesterday = addLocalDays(today, -1);
  const start = zonedDateTime(yesterday.year, yesterday.month, yesterday.day, 0, timeZone);
  const end = zonedDateTime(today.year, today.month, today.day, 0, timeZone);
  const dayKey = `${yesterday.year}-${String(yesterday.month).padStart(2, "0")}-${String(yesterday.day).padStart(2, "0")}`;
  return { start, end, dayKey };
}

/**
 * 解析一句问话里的时间指向。认不出就返回 null（调用方退化成关键词检索）。
 */
export function parseEventTimeRange(
  query: string,
  now: Date = new Date(),
  timeZone = TIME_ZONE_DEFAULT,
): EventTimeRange | null {
  const text = query.normalize("NFKC");
  const today = readLocalParts(now, timeZone);

  const relative: Array<{ pattern: RegExp; days: number; label: string }> = [
    { pattern: /大前天/, days: -3, label: "大前天" },
    { pattern: /前天/, days: -2, label: "前天" },
    { pattern: /昨天|昨日/, days: -1, label: "昨天" },
    { pattern: /今天|今日|今晚/, days: 0, label: "今天" },
    { pattern: /后天/, days: 2, label: "后天" },
    { pattern: /明天|明日/, days: 1, label: "明天" },
  ];
  for (const entry of relative) {
    if (entry.pattern.test(text)) {
      return narrowByPartOfDay(dayRange(addLocalDays(today, entry.days), timeZone, entry.label), text, timeZone);
    }
  }

  const daysAgo = /(\d{1,2})\s*天前/.exec(text);
  if (daysAgo) {
    return narrowByPartOfDay(dayRange(addLocalDays(today, -Number(daysAgo[1])), timeZone, `${daysAgo[1]} 天前`), text, timeZone);
  }

  const iso = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
  if (iso) {
    const [year, month, day] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
    if (validDate(year, month, day)) {
      return narrowByPartOfDay(
        dayRange({ year, month, day, hour: 0, minute: 0, second: 0 }, timeZone, iso[0]),
        text,
        timeZone,
      );
    }
  }

  const cnDate = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/.exec(text);
  if (cnDate) {
    const [year, month, day] = [Number(cnDate[1]), Number(cnDate[2]), Number(cnDate[3])];
    if (validDate(year, month, day)) {
      return narrowByPartOfDay(
        dayRange({ year, month, day, hour: 0, minute: 0, second: 0 }, timeZone, cnDate[0]),
        text,
        timeZone,
      );
    }
  }

  // 年月优先于「去年 / 上个月」整段范围；完整日期已在上面优先解析。
  const relativeYearMonth = /(前年|去年|今年)\s*(\d{1,2})\s*月/u.exec(text);
  if (relativeYearMonth) {
    const offset = relativeYearMonth[1] === "前年" ? -2 : relativeYearMonth[1] === "去年" ? -1 : 0;
    return monthRange(today.year + offset, Number(relativeYearMonth[2]), timeZone, relativeYearMonth[0]);
  }

  const absoluteYearMonth = /(\d{4})\s*年\s*(\d{1,2})\s*月/u.exec(text);
  if (absoluteYearMonth) {
    return monthRange(Number(absoluteYearMonth[1]), Number(absoluteYearMonth[2]), timeZone, absoluteYearMonth[0]);
  }

  const relativeYear = /(前年|去年|今年)/u.exec(text);
  if (relativeYear) {
    const offset = relativeYear[1] === "前年" ? -2 : relativeYear[1] === "去年" ? -1 : 0;
    return yearRange(today.year + offset, timeZone, relativeYear[1]);
  }

  const absoluteYear = /(\d{4})\s*年/u.exec(text);
  if (absoluteYear) return yearRange(Number(absoluteYear[1]), timeZone, absoluteYear[0]);

  const relativeMonth = /(上上个月|上个月|本月|这个月)/u.exec(text);
  if (relativeMonth) {
    const offset = relativeMonth[1] === "上上个月" ? -2 : relativeMonth[1] === "上个月" ? -1 : 0;
    const target = addLocalMonths(today, offset);
    return monthRange(target.year, target.month, timeZone, relativeMonth[1]);
  }

  const monthsAgo = /(\d{1,2})\s*个月前/u.exec(text);
  if (monthsAgo) {
    const count = Number(monthsAgo[1]);
    if (count >= 1 && count <= 120) {
      const target = addLocalMonths(today, -count);
      return monthRange(target.year, target.month, timeZone, monthsAgo[0]);
    }
  }

  const monthDay = /(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/.exec(text);
  if (monthDay) {
    const resolved = inCurrentYear(Number(monthDay[1]), Number(monthDay[2]), today);
    if (validDate(resolved.year, resolved.month, resolved.day)) {
      return narrowByPartOfDay(
        dayRange({ ...resolved, hour: 0, minute: 0, second: 0 }, timeZone, monthDay[0]),
        text,
        timeZone,
      );
    }
  }

  // 上周X / 这周X / 周X：先认「上周X」，再认「本周X」，最后才是裸「周X」。
  const lastWeekDay = /上(?:个)?(?:周|星期|礼拜)([一二三四五六日天])/.exec(text);
  const thisWeekDay = /(?:本|这|这个)(?:周|星期|礼拜)([一二三四五六日天])/.exec(text);
  const bareWeekDay = /(?:^|[^上本这])(?:周|星期|礼拜)([一二三四五六日天])/.exec(text);
  const weekMatch = lastWeekDay ?? thisWeekDay ?? bareWeekDay;
  const weekKey = weekMatch?.[1];
  if (weekMatch && weekKey) {
    const targetWeekday = WEEKDAY_INDEX[weekKey] ?? 1;
    const currentWeekday = weekdayOf(today);
    // 以周一为一周起点：「本周三」= 今天 + (3 - 当前星期)。裸「周X」问的是最近一个
    // 已经过去的周X —— 今天周六说「周三」，指的是这周三（10 月 28 日），不是下周。
    let offset = targetWeekday - currentWeekday;
    if (lastWeekDay) offset -= 7;
    if (!lastWeekDay && !thisWeekDay && offset > 0) offset -= 7;
    const target = addLocalDays(today, offset);
    return narrowByPartOfDay(dayRange(target, timeZone, weekMatch[0]), text, timeZone);
  }

  if (/上(?:个)?(?:周|星期|礼拜)/.test(text)) {
    const currentWeekday = weekdayOf(today);
    const monday = addLocalDays(today, -(currentWeekday - 1) - 7);
    const nextMonday = addLocalDays(monday, 7);
    return {
      start: zonedDateTime(monday.year, monday.month, monday.day, 0, timeZone),
      end: zonedDateTime(nextMonday.year, nextMonday.month, nextMonday.day, 0, timeZone),
      label: "上周",
    };
  }
  if (/(?:本|这|这个)(?:周|星期|礼拜)/.test(text)) {
    const currentWeekday = weekdayOf(today);
    const monday = addLocalDays(today, -(currentWeekday - 1));
    const nextMonday = addLocalDays(monday, 7);
    return {
      start: zonedDateTime(monday.year, monday.month, monday.day, 0, timeZone),
      end: zonedDateTime(nextMonday.year, nextMonday.month, nextMonday.day, 0, timeZone),
      label: "本周",
    };
  }

  return null;
}
