/**
 * 主动找话的设置与硬闸门。全是纯函数：判定必须在调模型之前完成，「不该发」时一次 token 都不花。
 */

import { usageDayKey } from "./model-usage";

export type ProactiveSettings = {
  enabled: boolean;
  /** 每天最多主动几条。 */
  dailyMax: number;
  /** 两条之间的最小间隔（分钟）。 */
  minGapMinutes: number;
  /** 安静时段起点（含）。 */
  quietStart: string;
  /** 安静时段终点（不含）。允许跨午夜。 */
  quietEnd: string;
  /** 主人最近这么多分钟内说过话，就当作「还在聊」，不打扰。 */
  userActiveMinutes: number;
  /** 挑目的的最低置信度。 */
  minConfidence: number;
};

/**
 * 全部默认值取「最不打扰」那一档，`enabled` 默认 **false**：
 * 主动找话是唯一一条「她先开口」的路径，默认开等于让用户先来解释「你怎么突然找我」。
 */
export const PROACTIVE_DEFAULTS: ProactiveSettings = {
  enabled: false,
  dailyMax: 2,
  minGapMinutes: 180,
  quietStart: "23:00",
  quietEnd: "08:00",
  userActiveMinutes: 30,
  minConfidence: 0.4,
};

// 宽容接受 "7:5" / "07:05"：手填的人会写前者，控件给的是后者，没必要让前者报错。
const TIME_RE = /^(\d{1,2}):(\d{1,2})$/;

/** "23:00" → 1380；非法返回 null。 */
export function readClockMinutes(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = value.trim().match(TIME_RE);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

/** 分钟数 → 统一的 "HH:MM"，存进库的都是这个形态。 */
export function formatClockMinutes(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

/** 小数区间用这个：minConfidence 是 0-1，走 clamp 会被四舍五入到 0 或 1。 */
function clampFloat(value: number, min: number, max: number): number {
  return Math.round(Math.max(min, Math.min(max, value)) * 100) / 100;
}

/** 从角色 modelConfig 里读设置；缺字段一律回落默认值，坏值不抛错（否则一条脏数据会卡死整轮）。 */
export function resolveProactiveSettings(modelConfig: unknown): ProactiveSettings {
  const raw = asRecord(asRecord(modelConfig).proactive);
  const bool = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);
  const num = (value: unknown, fallback: number, min: number, max: number) =>
    (typeof value === "number" && Number.isFinite(value) ? clamp(value, min, max) : fallback);
  const ratio = (value: unknown, fallback: number) =>
    (typeof value === "number" && Number.isFinite(value) ? clampFloat(value, 0, 1) : fallback);
  const clock = (value: unknown, fallback: string) => {
    const minutes = readClockMinutes(value);
    return minutes === null ? fallback : formatClockMinutes(minutes);
  };

  const quietStart = clock(raw.quietStart, PROACTIVE_DEFAULTS.quietStart);
  const quietEnd = clock(raw.quietEnd, PROACTIVE_DEFAULTS.quietEnd);
  // 起止一样就退化成「没有安静时段」，那不是用户想要的，直接当没配
  const quietDisabled = quietStart === quietEnd;

  return {
    enabled: bool(raw.enabled, PROACTIVE_DEFAULTS.enabled),
    dailyMax: num(raw.dailyMax, PROACTIVE_DEFAULTS.dailyMax, 0, 24),
    minGapMinutes: num(raw.minGapMinutes, PROACTIVE_DEFAULTS.minGapMinutes, 15, 1440),
    quietStart: quietDisabled ? PROACTIVE_DEFAULTS.quietStart : quietStart,
    quietEnd: quietDisabled ? PROACTIVE_DEFAULTS.quietEnd : quietEnd,
    userActiveMinutes: num(raw.userActiveMinutes, PROACTIVE_DEFAULTS.userActiveMinutes, 0, 720),
    minConfidence: ratio(raw.minConfidence, PROACTIVE_DEFAULTS.minConfidence),
  };
}

/** 页面提交的设置（只带用户改过的字段）。 */
export type ProactivePatch = Partial<ProactiveSettings>;

function readInt(raw: Record<string, unknown>, key: string, label: string, min: number, max: number): number | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${label}必须是 ${min} 到 ${max} 之间的整数。`);
  }
  return n;
}

function readClockField(raw: Record<string, unknown>, key: string, label: string): string | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  const minutes = readClockMinutes(value);
  if (minutes === null) throw new Error(`${label}必须是 HH:MM 格式的时间（例如 23:00）。`);
  return formatClockMinutes(minutes);
}

/**
 * 校验写入。与 `resolveProactiveSettings` 相反：那边夹取（读到脏数据不能崩），这边**报错**。
 * 夹取若写在保存路径上，用户会以为「我填的 90 分钟」存住了，实际存成 24 条。
 */
export function readProactivePatch(input: unknown): ProactivePatch {
  const raw = asRecord(input);
  const patch: ProactivePatch = {};

  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== "boolean") throw new Error("主动找话开关必须是布尔值。");
    patch.enabled = raw.enabled;
  }

  const dailyMax = readInt(raw, "dailyMax", "每天最多主动几条", 0, 24);
  if (dailyMax !== undefined) patch.dailyMax = dailyMax;
  const minGapMinutes = readInt(raw, "minGapMinutes", "两条之间的最小间隔", 15, 1440);
  if (minGapMinutes !== undefined) patch.minGapMinutes = minGapMinutes;
  const userActiveMinutes = readInt(raw, "userActiveMinutes", "主人说话后静默多久", 0, 720);
  if (userActiveMinutes !== undefined) patch.userActiveMinutes = userActiveMinutes;

  if (raw.minConfidence !== undefined) {
    const n = typeof raw.minConfidence === "number" ? raw.minConfidence : Number(raw.minConfidence);
    if (!Number.isFinite(n) || n < 0 || n > 1) throw new Error("最低置信度必须是 0 到 1 之间的数字。");
    patch.minConfidence = clampFloat(n, 0, 1);
  }

  const quietStart = readClockField(raw, "quietStart", "安静时段起点");
  if (quietStart !== undefined) patch.quietStart = quietStart;
  const quietEnd = readClockField(raw, "quietEnd", "安静时段终点");
  if (quietEnd !== undefined) patch.quietEnd = quietEnd;

  // 起止相同等于「没有安静时段」，而读取侧会把它当「没配」退回默认窗口。
  // 用户以为是全天能发，实际 23:00–08:00 仍然闭嘴，所以写入这层就得挡住。
  if (quietStart !== undefined && quietEnd !== undefined && quietStart === quietEnd) {
    throw new Error("安静时段的起止时间不能相同；不想设安静时段就把它关掉。");
  }

  return patch;
}

/** 东八区的「分钟数」，与 usageDayKey 的日界口径保持一致。 */
export function clockMinutesCst(date: Date): number {
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}

/** 当前是否在安静时段（支持跨午夜，例如 23:00–08:00）。 */
export function inQuietHours(now: Date, settings: Pick<ProactiveSettings, "quietStart" | "quietEnd">): boolean {
  const start = readClockMinutes(settings.quietStart);
  const end = readClockMinutes(settings.quietEnd);
  if (start === null || end === null || start === end) return false;
  const current = clockMinutesCst(now);
  return start < end
    ? current >= start && current < end
    : current >= start || current < end;
}

export type ProactiveGateInput = {
  settings: ProactiveSettings;
  now: Date;
  /** 今天（东八区）已经主动发了几条。 */
  sentToday: number;
  /** 上一条真发出去的时间。 */
  lastSentAt: Date | null;
  /** 主人最后一条消息的时间；null = 从来没说过话。 */
  lastUserMessageAt: Date | null;
  /** 模型额度是否已经用超。 */
  quotaExceeded: boolean;
  /** 有没有可以投递的私聊会话（QQ 私信要一个收件人）。 */
  hasRecipient: boolean;
};

export type ProactiveGateResult = { allowed: boolean; reason: string };

/**
 * 硬闸门，任何一条不过都不发。
 *
 * 配置性问题（开关 / 上限 / 收件人 / 额度）必须压在时间性问题之前：
 * 反过来的话日志里天天是「没到间隔」，而真实原因是压根没绑 QQ。
 */
export function evaluateProactiveGate(input: ProactiveGateInput): ProactiveGateResult {
  const { settings, now } = input;
  if (!settings.enabled) return { allowed: false, reason: "disabled" };
  if (settings.dailyMax <= 0) return { allowed: false, reason: "daily_max_zero" };
  if (!input.hasRecipient) return { allowed: false, reason: "no_recipient" };
  if (input.quotaExceeded) return { allowed: false, reason: "quota_exceeded" };
  if (input.sentToday >= settings.dailyMax) return { allowed: false, reason: "daily_limit" };
  if (inQuietHours(now, settings)) return { allowed: false, reason: "quiet_hours" };

  if (input.lastSentAt) {
    const gapMs = now.getTime() - input.lastSentAt.getTime();
    if (gapMs < settings.minGapMinutes * 60 * 1000) return { allowed: false, reason: "min_gap" };
  }

  // 主人刚说完话就别凑上来 —— 那是「接话」，不是「主动找」。
  if (input.lastUserMessageAt && settings.userActiveMinutes > 0) {
    const idleMs = now.getTime() - input.lastUserMessageAt.getTime();
    if (idleMs < settings.userActiveMinutes * 60 * 1000) return { allowed: false, reason: "user_active" };
  }

  return { allowed: true, reason: "ok" };
}

/** 今天已经发了几条（按东八区日界，和额度统计同一把尺）。 */
export function proactiveDayKey(now: Date): string {
  return usageDayKey(now);
}

/** 目的文本归一化：用于去重，不做展示。 */
export function normalizeGoal(goal: string): string {
  return (goal || "")
    .toLowerCase()
    .replace(/[\s]+/g, "")
    .replace(/[，。！？、；：""''（）()【】\[\]…—\-~～!?,.;:]/g, "")
    .slice(0, 120);
}

/** 去重键 = 种类 + 归一化目的。同一角色同一目的不重复入库。 */
export function goalDedupeKey(kind: string, goal: string): string {
  return `${kind}:${normalizeGoal(goal)}`.slice(0, 255);
}

export type ScoredIntent = {
  confidence: number;
  urgency: number;
  createdAt: Date;
};

/**
 * 挑哪一条开口。置信度是主项，紧迫度次之，新鲜度只占两成 ——
 * 给它更高权重，池子会退化成「永远说最新那条」，攒着想问的事就永远轮不到。
 */
export function scoreIntent(intent: ScoredIntent, now: Date): number {
  const ageHours = Math.max(0, (now.getTime() - intent.createdAt.getTime()) / 3_600_000);
  const freshness = 1 / (1 + ageHours / 24);
  const confidence = Math.max(0, Math.min(1, intent.confidence));
  const urgency = Math.max(0, Math.min(1, intent.urgency));
  return confidence * 0.5 + urgency * 0.3 + freshness * 0.2;
}

/** 从候选里挑一条：先按置信度门槛过滤，再取分数最高。 */
export function pickIntent<T extends ScoredIntent & { confidence: number }>(
  intents: readonly T[],
  now: Date,
  minConfidence: number,
): T | null {
  const eligible = intents.filter((intent) => intent.confidence >= minConfidence);
  if (!eligible.length) return null;
  let best = eligible[0]!;
  let bestScore = scoreIntent(best, now);
  for (const intent of eligible.slice(1)) {
    const score = scoreIntent(intent, now);
    if (score > bestScore) {
      best = intent;
      bestScore = score;
    }
  }
  return best;
}
