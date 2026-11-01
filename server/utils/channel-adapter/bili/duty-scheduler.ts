/**
 * B站值班的谷时窗口调度逻辑 —— 从 bili-desk 的 agent.py scheduler_loop 迁移而来。
 *
 * 与 bili-desk 的关键差异：这里只做**纯逻辑判断**（现在是不是谷时窗口、今天刷过没、
 * 还有没有额度），不做进程内死循环。真正的"何时触发"由调用方（长驻脚本或
 * MemoryJob 队列）决定，满足 CLAUDE.md 第 8 条的持久化/幂等要求。
 */

import type { BiliDutyConfig } from "./configure";

export type BiliWindowKey = "noon" | "night";

/** 谷时窗口定义（与 bili-desk 一致）。 */
export const BILI_WINDOWS: Record<BiliWindowKey, { start: string; end: string }> = {
  noon: { start: "12:00", end: "14:00" },
  night: { start: "18:00", end: "09:00" },
};

export type BiliDutyState = {
  day: string;
  /** 今天已挑条数。 */
  picked: number;
  /** 今天已跑的窗口标记，如 "2026-10-25:noon"。 */
  windowsRun: string[];
};

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function toDayKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** `HH:MM`，供 inWindow 比较。 */
export function toTimeKey(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 窗口所属的「业务日」。
 *
 * 夜间窗口跨午夜（18:00–09:00），所以当晚 18:30 和次日 02:00 是**同一个夜**。
 * 如果直接用自然日拼窗口标记，一个夜会被算成两天各跑一轮（当晚跑一次、凌晨又跑一次）。
 * 这里把凌晨 0–9 点归到前一天，于是两侧都得到同一个 `YYYY-MM-DD:night`。
 */
export function windowDayKey(now: Date, window: BiliWindowKey): string {
  if (window === "night" && now.getHours() < 9) {
    return toDayKey(new Date(now.getTime() - 24 * 60 * 60 * 1000));
  }
  return toDayKey(now);
}

/**
 * 从「已跑过的轮次时间戳」反推今天跑过哪些窗口。
 *
 * 用途：长驻脚本重启后，内存里的窗口标记会丢。用报告（BiliRoundReport.createdAt）
 * 重建标记，才不会在同一个窗口里重复刷一轮 —— 这正是不持久化就会踩的坑。
 */
export function windowsRunFromTimestamps(timestamps: Date[]): string[] {
  const marks = new Set<string>();
  for (const timestamp of timestamps) {
    if (Number.isNaN(timestamp.getTime())) continue;
    const time = toTimeKey(timestamp);
    for (const key of ["noon", "night"] as const) {
      if (!inWindow(time, key)) continue;
      marks.add(`${windowDayKey(timestamp, key)}:${key}`);
    }
  }
  return [...marks];
}

/** 判断某个时刻是否落在某个谷时窗口内（支持跨午夜，如夜间 18:00-09:00）。 */
export function inWindow(time: string, window: BiliWindowKey): boolean {
  const { start, end } = BILI_WINDOWS[window];
  if (start < end) {
    return start <= time && time < end;
  }
  // 跨午夜窗口（night：18:00-09:00）
  return time >= start || time < end;
}

/** 计算此刻应触发哪个窗口（若在窗口内且今天该窗口还没跑过）。 */
export function dueWindow(now: Date, config: BiliDutyConfig, state: BiliDutyState): BiliWindowKey | null {
  if (!config.peakValley) return null;
  const time = toTimeKey(now);
  for (const key of ["noon", "night"] as const) {
    if (!config[key]) continue;
    if (!inWindow(time, key)) continue;
    // 用窗口自己的业务日，而不是自然日 —— 否则跨午夜的夜间窗口会跑两轮
    const mark = `${windowDayKey(now, key)}:${key}`;
    if (state.windowsRun.includes(mark)) continue;
    return key;
  }
  return null;
}

/** 今天是否还有额度可以刷。 */
export function hasQuota(config: BiliDutyConfig, state: BiliDutyState): boolean {
  return state.picked < config.perDay;
}

/**
 * 综合判断：此刻是否应该刷一轮。
 * 需要满足：谷时窗口内 + 今天该窗口没跑过 + 还有额度 + 没在跑。
 */
export function shouldRunDuty(
  now: Date,
  config: BiliDutyConfig,
  state: BiliDutyState,
  running: boolean,
): { due: boolean; window: BiliWindowKey | null; reason: string } {
  if (running) return { due: false, window: null, reason: "上一轮还没跑完" };
  if (!config.peakValley) return { due: false, window: null, reason: "已关闭谷时调度" };
  if (!hasQuota(config, state)) {
    return { due: false, window: null, reason: `今天额度已用完（${state.picked}/${config.perDay}）` };
  }
  const window = dueWindow(now, config, state);
  if (!window) {
    return { due: false, window: null, reason: "当前不在谷时窗口内，或该窗口今天已跑过" };
  }
  return { due: true, window, reason: `谷时窗口 ${window} 触发` };
}

/** 剩余额度。 */
export function remainingQuota(config: BiliDutyConfig, state: BiliDutyState): number {
  return Math.max(0, config.perDay - state.picked);
}
