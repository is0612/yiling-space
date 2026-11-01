/**
 * QQ 群「自己找话题」的设置与硬闸门。全是纯函数：判定必须在调模型之前完成。
 *
 * 与私聊主动找话（`proactive-settings.ts`）是**两套**设置，理由不是洁癖：
 *   - 私聊的节奏是「这个人」，群里的节奏是「这个群」——一个群安静了两小时，
 *     另一个群可能一分钟几十条，共用一个阈值必然有一边是错的；
 *   - 私聊开口是「我想跟他说」，群里开口是「你们怎么都不说话了」，
 *     后者的社交风险高得多，默认值就该更保守（默认关、默认 60 分钟、默认每群每天 3 条）。
 */

import { formatClockMinutes, inQuietHours, readClockMinutes } from "./proactive-settings";

export type GroupInitiativeSettings = {
  enabled: boolean;
  /** 群里安静了多少分钟才算「冷场」。 */
  idleMinutes: number;
  /** 每个群每天最多主动开几次话题。 */
  dailyMax: number;
  /** 同一个群两次尝试之间至少隔多久（分钟）。 */
  minGapMinutes: number;
  /** 安静时段起点（含），对她主动开口同样有效 —— 凌晨的群不需要被叫醒。 */
  quietStart: string;
  /** 安静时段终点（不含）。允许跨午夜。 */
  quietEnd: string;
};

/**
 * 默认值取「克制但不至于从不开口」那一档，`enabled` **默认 false**。
 *
 * `idleMinutes = 60`：短于这个数的沉默在群里很正常（大家在忙），
 * 上去说话就是抢戏；长于这个数又只剩下死群，功能白开。
 */
export const GROUP_INITIATIVE_DEFAULTS: GroupInitiativeSettings = {
  enabled: false,
  idleMinutes: 60,
  dailyMax: 3,
  minGapMinutes: 180,
  quietStart: "23:30",
  quietEnd: "07:30",
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

/** 从角色 modelConfig 里读设置；缺字段回落默认值，坏值不抛错（一条脏数据不该卡死整轮）。 */
export function resolveGroupInitiativeSettings(modelConfig: unknown): GroupInitiativeSettings {
  const raw = asRecord(asRecord(modelConfig).groupInitiative);
  const bool = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);
  const num = (value: unknown, fallback: number, min: number, max: number) =>
    (typeof value === "number" && Number.isFinite(value) ? clamp(value, min, max) : fallback);
  const clock = (value: unknown, fallback: string) => {
    const minutes = readClockMinutes(value);
    return minutes === null ? fallback : formatClockMinutes(minutes);
  };

  const quietStart = clock(raw.quietStart, GROUP_INITIATIVE_DEFAULTS.quietStart);
  const quietEnd = clock(raw.quietEnd, GROUP_INITIATIVE_DEFAULTS.quietEnd);
  // 起止相同等于「没有安静时段」，那不是用户想要的，按没配处理。
  const quietDisabled = quietStart === quietEnd;

  return {
    enabled: bool(raw.enabled, GROUP_INITIATIVE_DEFAULTS.enabled),
    idleMinutes: num(raw.idleMinutes, GROUP_INITIATIVE_DEFAULTS.idleMinutes, 15, 1440),
    dailyMax: num(raw.dailyMax, GROUP_INITIATIVE_DEFAULTS.dailyMax, 0, 24),
    minGapMinutes: num(raw.minGapMinutes, GROUP_INITIATIVE_DEFAULTS.minGapMinutes, 30, 1440),
    quietStart: quietDisabled ? GROUP_INITIATIVE_DEFAULTS.quietStart : quietStart,
    quietEnd: quietDisabled ? GROUP_INITIATIVE_DEFAULTS.quietEnd : quietEnd,
  };
}

export type GroupInitiativePatch = Partial<GroupInitiativeSettings>;

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
  if (minutes === null) throw new Error(`${label}必须是 HH:MM 格式的时间（例如 23:30）。`);
  return formatClockMinutes(minutes);
}

/**
 * 校验写入。与读取侧相反：那边夹取（读到脏数据不能崩），这边**报错** ——
 * 保存路径上夹取会让用户以为自己填的值生效了。
 */
export function readGroupInitiativePatch(input: unknown): GroupInitiativePatch {
  const raw = asRecord(input);
  const patch: GroupInitiativePatch = {};

  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== "boolean") throw new Error("群内找话题开关必须是布尔值。");
    patch.enabled = raw.enabled;
  }

  const idleMinutes = readInt(raw, "idleMinutes", "群里安静多久算冷场", 15, 1440);
  if (idleMinutes !== undefined) patch.idleMinutes = idleMinutes;
  const dailyMax = readInt(raw, "dailyMax", "每群每天最多主动几次", 0, 24);
  if (dailyMax !== undefined) patch.dailyMax = dailyMax;
  const minGapMinutes = readInt(raw, "minGapMinutes", "同一个群两次之间的最小间隔", 30, 1440);
  if (minGapMinutes !== undefined) patch.minGapMinutes = minGapMinutes;

  const quietStart = readClockField(raw, "quietStart", "安静时段起点");
  if (quietStart !== undefined) patch.quietStart = quietStart;
  const quietEnd = readClockField(raw, "quietEnd", "安静时段终点");
  if (quietEnd !== undefined) patch.quietEnd = quietEnd;

  if (quietStart !== undefined && quietEnd !== undefined && quietStart === quietEnd) {
    throw new Error("安静时段的起止时间不能相同；不想设安静时段就把它关掉。");
  }

  return patch;
}

export type GroupInitiativeGateInput = {
  settings: GroupInitiativeSettings;
  now: Date;
  /**
   * 这个群在「自然接话」里的档位（`config.groupChatMode`，按群覆盖后）。
   *
   * `mention` = 只在她被 @ 时才回 —— 那是主人/群主对这个群的显式意图：
   * 别在这里自己冒头。所以这种群一律不主动起话题，连闸门的时间判断都不进。
   *
   * **必填**：留成可选的话，将来某个调用方忘了传就等于「所有群都可开口」，
   * 而这类错只会在别人的群里以「她怎么突然说话」的形式被发现。
   */
  groupMode: "mention" | "ambient" | "all";
  /** 这个群实际安静了多少分钟（从「最后一条群消息」和「她最后一次说话」里取更近的）。 */
  idleMinutes: number;
  /** 这个群今天她已经主动开过几次话题。 */
  sentToday: number;
  /** 最后一次为这个群花过模型调用的时刻（含模型判定不说的尝试）。 */
  lastAttemptAt: Date | null;
  /** 模型额度是否用超。 */
  quotaExceeded: boolean;
  /**
   * 只给页面上的「立即试一次」用：跳过时间类闸门（安静时段 / 冷场 / 间隔 / 每日条数）。
   * **不跳**开关、`dailyMax = 0` 和额度 —— 那几条跳掉，这个按钮就等于「绕过所有保护」。
   */
  ignoreTimeGates?: boolean;
};

export type GroupInitiativeGateResult = { allowed: boolean; reason: string };

/**
 * 硬闸门，任何一条不过都不开口。
 *
 * 顺序与私聊一致：配置性问题（开关 / 上限 / 额度）压在时间性问题（安静时段 / 冷场 / 间隔）前面。
 * 反过来日志里会天天是「没到间隔」，而真实原因是压根没配模型额度。
 */
export function evaluateGroupInitiativeGate(input: GroupInitiativeGateInput): GroupInitiativeGateResult {
  const { settings, now } = input;
  if (!settings.enabled) return { allowed: false, reason: "disabled" };
  if (settings.dailyMax <= 0) return { allowed: false, reason: "daily_max_zero" };
  // 「仅被 @ 时回复」是对整个群的显式意图，优先级高于额度和时间判断：
  // 这种群里她连开口的资格都没有，报「额度用完」会把人指去查账。
  if (input.groupMode === "mention") return { allowed: false, reason: "mention_only" };
  if (input.quotaExceeded) return { allowed: false, reason: "quota_exceeded" };
  if (input.ignoreTimeGates) return { allowed: true, reason: "ok" };
  if (input.sentToday >= settings.dailyMax) return { allowed: false, reason: "daily_limit" };
  if (inQuietHours(now, settings)) return { allowed: false, reason: "quiet_hours" };

  // 冷场是前提：群里还在说话就不叫「找话题」，那叫插嘴，由接话链路负责。
  if (input.idleMinutes < settings.idleMinutes) return { allowed: false, reason: "not_idle" };

  if (input.lastAttemptAt) {
    const gapMinutes = (now.getTime() - input.lastAttemptAt.getTime()) / 60_000;
    if (gapMinutes < settings.minGapMinutes) return { allowed: false, reason: "min_gap" };
  }

  return { allowed: true, reason: "ok" };
}

const REASON_LABELS: Record<string, string> = {
  disabled: "群内找话题没开",
  daily_max_zero: "每群每天条数设成了 0",
  mention_only: "这个群设的是仅被 @ 时回复",
  quota_exceeded: "今天的模型额度用完了",
  daily_limit: "这个群今天的条数用完了",
  quiet_hours: "现在在安静时段",
  not_idle: "群里还没冷下来",
  min_gap: "离上次尝试还不够久",
  just_attempted: "刚在别的群开过口，这轮先不追",
  nothing_to_say: "她这轮没想说什么",
  model_error: "模型调用失败",
  send_failed: "群消息发送失败",
  no_group: "没有可用的群",
  /** 闸门放行但还没开口：tick 里 `ok` 是「真的发出去了」，页面状态卡不能借用同一句。 */
  ready: "现在可以开口",
  ok: "发出去了",
};

/** 机器可读的原因 → 页面上的中文。未知原因原样返回，方便排查。 */
export function describeGroupInitiativeReason(reason: string): string {
  return REASON_LABELS[reason] ?? reason;
}
