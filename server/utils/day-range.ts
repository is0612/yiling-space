/** 日期区间枚举：日历要画满一个月，「这天没有记录」也是一格。 */

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/u;

export function isDayKey(value: unknown): value is string {
  if (typeof value !== "string" || !DAY_KEY.test(value)) return false;
  // 排除 2026-02-31 这类格式对但日期不存在的值：回填成真实日期就说明它不存在。
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * 枚举 [from, to] 里的所有日期键（含两端）。
 * 顺序反了、或任一端不是合法日期，都返回空数组 —— 让调用方当作「没给区间」处理，
 * 而不是悄悄换成一个看起来合理但错的月份。
 */
export function enumerateDayKeys(from: string, to: string, maxDays = 366): string[] {
  if (!isDayKey(from) || !isDayKey(to) || from > to) return [];
  const keys: string[] = [];
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let cursor = start; cursor <= end && keys.length < maxDays; cursor += 86_400_000) {
    keys.push(new Date(cursor).toISOString().slice(0, 10));
  }
  return keys;
}

/** 某个日期所在月的起止（用于日历按月取数）；非法输入返回 null。 */
export function monthRange(monthKey: string): { from: string; to: string } | null {
  if (!/^\d{4}-\d{2}$/u.test(monthKey)) return null;
  const [year, month] = monthKey.split("-").map(Number);
  if (!year || !month || month < 1 || month > 12) return null;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const from = `${monthKey}-01`;
  const to = `${monthKey}-${String(lastDay).padStart(2, "0")}`;
  return isDayKey(from) && isDayKey(to) ? { from, to } : null;
}
