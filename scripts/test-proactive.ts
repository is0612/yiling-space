import assert from "node:assert/strict";
import {
  PROACTIVE_KIND_KEYS,
  isProactiveKind,
  parseMessage,
  parseIntents,
} from "../server/utils/proactive-prompt";
import {
  PROACTIVE_DEFAULTS,
  clockMinutesCst,
  evaluateProactiveGate,
  goalDedupeKey,
  inQuietHours,
  normalizeGoal,
  pickIntent,
  proactiveDayKey,
  readClockMinutes,
  readProactivePatch,
  resolveProactiveSettings,
  scoreIntent,
  type ProactiveSettings,
} from "../server/utils/proactive-settings";

/** 造一个东八区的时刻：cst(h, m) → Date。 */
function cst(hour: number, minute = 0, day = 15): Date {
  // UTC = CST - 8h，所以 UTC 时间要往前提 8 小时。
  return new Date(Date.UTC(2026, 0, day, hour - 8, minute));
}

/* ---------- 默认值与读入 ---------- */

assert.equal(PROACTIVE_DEFAULTS.enabled, false, "主动找话必须默认关");
assert.deepEqual(resolveProactiveSettings({}), PROACTIVE_DEFAULTS, "空配置应回落到默认值");
assert.deepEqual(resolveProactiveSettings(null), PROACTIVE_DEFAULTS, "null 配置不该抛错");
assert.deepEqual(resolveProactiveSettings([]), PROACTIVE_DEFAULTS, "数组不是配置对象");

const full = resolveProactiveSettings({
  proactive: {
    enabled: true,
    dailyMax: 4,
    minGapMinutes: 90,
    quietStart: "22:30",
    quietEnd: "07:15",
    userActiveMinutes: 10,
    minConfidence: 0.6,
  },
});
assert.deepEqual(full, {
  enabled: true,
  dailyMax: 4,
  minGapMinutes: 90,
  quietStart: "22:30",
  quietEnd: "07:15",
  userActiveMinutes: 10,
  minConfidence: 0.6,
});

// 夹取：越界一律收进合法区间，脏数据不该让整轮 tick 抛错。
assert.equal(resolveProactiveSettings({ proactive: { dailyMax: 99 } }).dailyMax, 24);
assert.equal(resolveProactiveSettings({ proactive: { dailyMax: -3 } }).dailyMax, 0);
assert.equal(resolveProactiveSettings({ proactive: { dailyMax: 2.6 } }).dailyMax, 3, "小数四舍五入而不是截断");
assert.equal(resolveProactiveSettings({ proactive: { minGapMinutes: 1 } }).minGapMinutes, 15);
assert.equal(resolveProactiveSettings({ proactive: { minGapMinutes: 99999 } }).minGapMinutes, 1440);
assert.equal(resolveProactiveSettings({ proactive: { minConfidence: 5 } }).minConfidence, 1);
assert.equal(resolveProactiveSettings({ proactive: { minConfidence: -1 } }).minConfidence, 0);
assert.equal(resolveProactiveSettings({ proactive: { userActiveMinutes: 9999 } }).userActiveMinutes, 720);

// 坏值回落而不是夹取：字符串 "abc" 当成没填。
assert.equal(resolveProactiveSettings({ proactive: { dailyMax: "abc" } }).dailyMax, PROACTIVE_DEFAULTS.dailyMax);
assert.equal(resolveProactiveSettings({ proactive: { enabled: "yes" } }).enabled, false);

assert.equal(resolveProactiveSettings({ proactive: { quietStart: "8:30" } }).quietStart, "08:30", "补零成 HH:MM");
assert.equal(resolveProactiveSettings({ proactive: { quietStart: "7:5" } }).quietStart, "07:05");
assert.equal(resolveProactiveSettings({ proactive: { quietStart: "25:00" } }).quietStart, "23:00");
assert.equal(resolveProactiveSettings({ proactive: { quietStart: " 07:00 " } }).quietStart, "07:00");

// 起止相同 = 没配安静时段，退回默认窗口，而不是「全天安静」。
const sameClock = resolveProactiveSettings({ proactive: { quietStart: "10:00", quietEnd: "10:00" } });
assert.equal(sameClock.quietStart, PROACTIVE_DEFAULTS.quietStart);
assert.equal(sameClock.quietEnd, PROACTIVE_DEFAULTS.quietEnd);

/* ---------- 写入校验 ---------- */

assert.deepEqual(readProactivePatch({}), {}, "空 patch 不该塞进任何字段");
assert.deepEqual(readProactivePatch({ enabled: true }), { enabled: true });
assert.deepEqual(
  readProactivePatch({ dailyMax: "3", minGapMinutes: 90, quietStart: "7:5" }),
  { dailyMax: 3, minGapMinutes: 90, quietStart: "07:05" },
  "数字字符串收下，时刻补零成 HH:MM",
);

// 写入侧报错而不是夹取：填错了必须看得见。
assert.throws(() => readProactivePatch({ enabled: "yes" }), /布尔值/);
assert.throws(() => readProactivePatch({ dailyMax: 99 }), /0 到 24/);
assert.throws(() => readProactivePatch({ dailyMax: 1.5 }), /整数/);
assert.throws(() => readProactivePatch({ minGapMinutes: 5 }), /15 到 1440/);
assert.throws(() => readProactivePatch({ userActiveMinutes: -1 }), /0 到 720/);
assert.throws(() => readProactivePatch({ minConfidence: 1.5 }), /0 到 1/);
assert.throws(() => readProactivePatch({ quietStart: "25:00" }), /HH:MM/);
assert.throws(() => readProactivePatch({ quietEnd: "晚安" }), /HH:MM/);
assert.throws(() => readProactivePatch({ quietStart: "10:00", quietEnd: "10:00" }), /不能相同/);
assert.doesNotThrow(() => readProactivePatch({ quietStart: "10:00" }), "只改一端时不该拿另一端来比");

/* ---------- 时刻换算 ---------- */

assert.equal(readClockMinutes("00:00"), 0);
assert.equal(readClockMinutes("23:59"), 1439);
assert.equal(readClockMinutes("24:00"), null);
assert.equal(readClockMinutes("12:60"), null);
assert.equal(readClockMinutes(720), null);
assert.equal(readClockMinutes(null), null);

assert.equal(clockMinutesCst(cst(0, 0)), 0);
assert.equal(clockMinutesCst(cst(23, 30)), 1410);
assert.equal(clockMinutesCst(cst(8, 5)), 485);

/* ---------- 安静时段 ---------- */

const overnight: Pick<ProactiveSettings, "quietStart" | "quietEnd"> = { quietStart: "23:00", quietEnd: "08:00" };
assert.equal(inQuietHours(cst(23, 0), overnight), true, "起点含");
assert.equal(inQuietHours(cst(23, 30), overnight), true);
assert.equal(inQuietHours(cst(3, 0), overnight), true, "跨午夜要算进去");
assert.equal(inQuietHours(cst(7, 59), overnight), true);
assert.equal(inQuietHours(cst(8, 0), overnight), false, "终点不含");
assert.equal(inQuietHours(cst(12, 0), overnight), false);
assert.equal(inQuietHours(cst(22, 59), overnight), false);

const daytime: Pick<ProactiveSettings, "quietStart" | "quietEnd"> = { quietStart: "12:00", quietEnd: "14:00" };
assert.equal(inQuietHours(cst(12, 0), daytime), true);
assert.equal(inQuietHours(cst(13, 0), daytime), true);
assert.equal(inQuietHours(cst(14, 0), daytime), false);
assert.equal(inQuietHours(cst(23, 0), daytime), false);

assert.equal(inQuietHours(cst(12, 0), { quietStart: "09:00", quietEnd: "09:00" }), false, "起止相同视为没有安静时段");

/* ---------- 闸门 ---------- */

const gateSettings: ProactiveSettings = { ...PROACTIVE_DEFAULTS, enabled: true };
const okInput = {
  settings: gateSettings,
  now: cst(15, 0),
  sentToday: 0,
  lastSentAt: null as Date | null,
  lastUserMessageAt: null as Date | null,
  quotaExceeded: false,
  hasRecipient: true,
};

assert.deepEqual(evaluateProactiveGate(okInput), { allowed: true, reason: "ok" });
assert.equal(evaluateProactiveGate({ ...okInput, sentToday: 2 }).reason, "daily_limit");
assert.equal(evaluateProactiveGate({ ...okInput, sentToday: 1 }).allowed, true, "没到上限照发");

assert.equal(evaluateProactiveGate({ ...okInput, settings: { ...gateSettings, enabled: false } }).reason, "disabled");
assert.equal(evaluateProactiveGate({ ...okInput, hasRecipient: false }).reason, "no_recipient");
assert.equal(evaluateProactiveGate({ ...okInput, quotaExceeded: true }).reason, "quota_exceeded");
assert.equal(evaluateProactiveGate({ ...okInput, settings: { ...gateSettings, dailyMax: 0 } }).reason, "daily_max_zero");

// 顺序：配置性问题要盖过时间性问题，否则日志里会一直看到「没到间隔」而真实原因是没绑 QQ。
assert.equal(
  evaluateProactiveGate({ ...okInput, hasRecipient: false, sentToday: 99, now: cst(3, 0) }).reason,
  "no_recipient",
);
assert.equal(evaluateProactiveGate({ ...okInput, sentToday: 2, now: cst(3, 0) }).reason, "daily_limit");

// 时间性闸门：安静时段先于间隔，间隔先于「主人在聊」。
assert.equal(evaluateProactiveGate({ ...okInput, now: cst(3, 0) }).reason, "quiet_hours");
assert.equal(
  evaluateProactiveGate({ ...okInput, lastSentAt: new Date(cst(14, 30).getTime()), now: cst(15, 0) }).reason,
  "min_gap",
);
assert.equal(
  evaluateProactiveGate({ ...okInput, lastSentAt: new Date(cst(11, 0).getTime()), now: cst(15, 0) }).allowed,
  true,
  "间隔够了就该放行",
);
assert.equal(
  evaluateProactiveGate({ ...okInput, lastUserMessageAt: new Date(cst(14, 45).getTime()) }).reason,
  "user_active",
);
assert.equal(
  evaluateProactiveGate({ ...okInput, lastUserMessageAt: new Date(cst(14, 0).getTime()) }).allowed,
  true,
  "超过 30 分钟算不在聊",
);
assert.equal(
  evaluateProactiveGate({
    ...okInput,
    settings: { ...gateSettings, userActiveMinutes: 0 },
    lastUserMessageAt: new Date(cst(14, 59).getTime()),
  }).allowed,
  true,
  "userActiveMinutes=0 表示不判这条",
);

/* ---------- 目的池 ---------- */

assert.equal(normalizeGoal("  想问问他  最近 怎么样？ "), "想问问他最近怎么样");
assert.equal(normalizeGoal("A，B。C！"), "abc");
assert.equal(normalizeGoal(""), "");
assert.equal(normalizeGoal("x".repeat(500)).length, 120);

assert.equal(goalDedupeKey("ASK", "想问问他最近怎么样"), goalDedupeKey("ASK", "想问问他  最近怎么样？"));
assert.notEqual(goalDedupeKey("ASK", "同一句话"), goalDedupeKey("SHARE", "同一句话"), "不同 kind 不互斥");

const t0 = cst(15, 0);
assert.equal(scoreIntent({ confidence: 1, urgency: 1, createdAt: t0 }, t0), 1);
assert.ok(Math.abs(scoreIntent({ confidence: 0.5, urgency: 0, createdAt: t0 }, t0) - 0.45) < 1e-9);
assert.ok(
  Math.abs(scoreIntent({ confidence: 0, urgency: 0, createdAt: new Date(t0.getTime() - 86_400_000) }, t0) - 0.1) < 1e-9,
  "放了 24 小时新鲜度只剩一半",
);
// 置信度是主项：高置信度的旧目的要赢过新鲜但凑数的那条。
const stale = { id: "stale", confidence: 0.9, urgency: 0.4, createdAt: new Date(t0.getTime() - 48 * 3_600_000) };
const fresh = { id: "fresh", confidence: 0.45, urgency: 0.4, createdAt: t0 };
assert.equal(pickIntent([stale, fresh], t0, 0)!.id, "stale");

assert.equal(pickIntent([], t0, 0), null);
assert.equal(pickIntent([{ confidence: 0.2, urgency: 1, createdAt: t0 }], t0, 0.4), null, "低于门槛一律不选");
assert.equal(
  pickIntent([
    { id: "low", confidence: 0.3, urgency: 1, createdAt: t0 },
    { id: "high", confidence: 0.8, urgency: 0, createdAt: t0 },
  ], t0, 0.4)!.id,
  "high",
);

assert.equal(proactiveDayKey(cst(0, 30)), proactiveDayKey(cst(23, 30)), "东八区同一天应同一个 key");
assert.notEqual(proactiveDayKey(cst(23, 30, 15)), proactiveDayKey(cst(0, 30, 16)));

/* ---------- 目的解析 ---------- */

assert.deepEqual(parseIntents(null), []);
assert.deepEqual(parseIntents({ kind: "ASK" }), []);
assert.deepEqual(parseIntents([{ kind: "UNKNOWN", goal: "想说点什么" }]), [], "不在清单里的 kind 丢弃");
assert.deepEqual(parseIntents([{ kind: "ASK", goal: "   " }]), [], "空 goal 丢弃");

const parsed = parseIntents([
  { kind: "ASK", goal: "  想问问他  最近怎么样  ", confidence: "0.8", urgency: 0.25 },
  { kind: "ASK", goal: "想问问他 最近怎么样", confidence: 0.9 },
  { kind: "SHARE", goal: "想给他看今天拍的照片", confidence: 5, urgency: -1 },
]);
assert.equal(parsed.length, 2, "同 kind 同文本只留第一条");
assert.deepEqual(parsed[0], { kind: "ASK", goal: "想问问他 最近怎么样", confidence: 0.8, urgency: 0.25 });
assert.equal(parsed[1]!.confidence, 1, "越界置信度夹到 1");
assert.equal(parsed[1]!.urgency, 0, "负数紧迫度夹到 0");

assert.equal(parseIntents([{ kind: "ASK", goal: "a" }, { kind: "ASK", goal: "b" }], 1).length, 1, "limit 生效");
assert.equal(parseIntents([{ kind: "ASK", goal: "缺字段" }])[0]!.confidence, 0.5, "缺 confidence 取中性值");
assert.equal(parseIntents([{ kind: "ASK", goal: "长".repeat(300) }])[0]!.goal.length, 160);

assert.deepEqual(PROACTIVE_KIND_KEYS, ["SHARE", "ASK", "INVITE", "CONFIDE", "CURIOUS", "FOLLOWUP"]);
assert.equal(isProactiveKind("SHARE"), true);
assert.equal(isProactiveKind("share"), false, "kind 大小写敏感");
assert.equal(isProactiveKind(undefined), false);

/* ---------- 正文解析 ---------- */

assert.equal(parseMessage("在吗"), "在吗");
assert.equal(parseMessage("  在吗  "), "在吗");
assert.equal(parseMessage("「在吗」"), "在吗");
assert.equal(parseMessage('"在吗"'), "在吗");
assert.equal(parseMessage("正文：在吗"), "在吗");
assert.equal(parseMessage("私信: 在吗"), "在吗");
assert.equal(parseMessage("第一行\n\n第二行"), "第一行 第二行", "多行压成一行");
assert.equal(parseMessage("-"), "", "减号表示不说");
assert.equal(parseMessage("——"), "");
assert.equal(parseMessage(""), "");
assert.equal(parseMessage("   "), "");
assert.equal(parseMessage("长".repeat(400)).length, 200);

console.log("proactive tests passed");
