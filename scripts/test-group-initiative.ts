import assert from "node:assert/strict";
import {
  GROUP_INITIATIVE_DEFAULTS,
  describeGroupInitiativeReason,
  evaluateGroupInitiativeGate,
  readGroupInitiativePatch,
  resolveGroupInitiativeSettings,
  type GroupInitiativeSettings,
} from "../server/utils/group-initiative-settings";
import { clockLabelCst, readRecentLines } from "../server/utils/group-initiative";
import {
  buildGroupInitiativeSystemPrompt,
  buildGroupInitiativeUserPrompt,
} from "../server/utils/group-initiative-prompt";
import { createGroupActivityRecorder } from "../server/utils/group-activity";

/** 东八区时刻：UTC = CST - 8h。 */
function cst(hour: number, minute = 0, day = 15): Date {
  return new Date(Date.UTC(2026, 0, day, hour - 8, minute));
}

/* ---------- 默认值与读入 ---------- */

assert.equal(GROUP_INITIATIVE_DEFAULTS.enabled, false, "群内找话题必须默认关");
assert.equal(GROUP_INITIATIVE_DEFAULTS.idleMinutes, 60, "默认安静 60 分钟算冷场");
assert.equal(GROUP_INITIATIVE_DEFAULTS.dailyMax, 3, "默认每个群每天 3 条");
assert.deepEqual(resolveGroupInitiativeSettings({}), GROUP_INITIATIVE_DEFAULTS, "空配置回落默认值");
assert.deepEqual(resolveGroupInitiativeSettings(null), GROUP_INITIATIVE_DEFAULTS, "null 不该抛错");
assert.deepEqual(resolveGroupInitiativeSettings([]), GROUP_INITIATIVE_DEFAULTS, "数组不是配置对象");

const full = resolveGroupInitiativeSettings({
  groupInitiative: {
    enabled: true,
    idleMinutes: 90,
    dailyMax: 1,
    minGapMinutes: 60,
    quietStart: "22:00",
    quietEnd: "07:00",
  },
});
assert.deepEqual(full, {
  enabled: true,
  idleMinutes: 90,
  dailyMax: 1,
  minGapMinutes: 60,
  quietStart: "22:00",
  quietEnd: "07:00",
});

// 夹取：脏数据不能让整轮 tick 抛错。
assert.equal(resolveGroupInitiativeSettings({ groupInitiative: { idleMinutes: 1 } }).idleMinutes, 15);
assert.equal(resolveGroupInitiativeSettings({ groupInitiative: { idleMinutes: 99999 } }).idleMinutes, 1440);
assert.equal(resolveGroupInitiativeSettings({ groupInitiative: { dailyMax: -1 } }).dailyMax, 0);
assert.equal(resolveGroupInitiativeSettings({ groupInitiative: { dailyMax: 99 } }).dailyMax, 24);
assert.equal(resolveGroupInitiativeSettings({ groupInitiative: { minGapMinutes: 1 } }).minGapMinutes, 30);
assert.equal(resolveGroupInitiativeSettings({ groupInitiative: { idleMinutes: "abc" } }).idleMinutes, 60);
assert.equal(resolveGroupInitiativeSettings({ groupInitiative: { enabled: "yes" } }).enabled, false);

// 「60」这种字符串也算填了：前端 el-input-number 清空时会给空串，给数字时是数字。
assert.equal(resolveGroupInitiativeSettings({ groupInitiative: { idleMinutes: 60 } }).idleMinutes, 60);

// 起止相同 = 没配安静时段，退回默认窗口。
const sameClock = resolveGroupInitiativeSettings({ groupInitiative: { quietStart: "10:00", quietEnd: "10:00" } });
assert.equal(sameClock.quietStart, GROUP_INITIATIVE_DEFAULTS.quietStart);
assert.equal(sameClock.quietEnd, GROUP_INITIATIVE_DEFAULTS.quietEnd);

/* ---------- 写入校验：宁可报错，不夹取 ---------- */

assert.deepEqual(readGroupInitiativePatch({}), {}, "空 patch 合法");
assert.equal(readGroupInitiativePatch({ enabled: true }).enabled, true);
assert.equal(readGroupInitiativePatch({ idleMinutes: "90" }).idleMinutes, 90, "字符串数字接受");
assert.equal(readGroupInitiativePatch({ quietStart: "7:5" }).quietStart, "07:05", "补零成 HH:MM");

for (const bad of [
  { enabled: "yes" },
  { idleMinutes: 5 },
  { idleMinutes: 2000 },
  { idleMinutes: 60.5 },
  { dailyMax: 25 },
  { minGapMinutes: 10 },
  { quietStart: "25:00" },
]) {
  assert.throws(() => readGroupInitiativePatch(bad), undefined, `应拒绝：${JSON.stringify(bad)}`);
}
assert.throws(
  () => readGroupInitiativePatch({ quietStart: "10:00", quietEnd: "10:00" }),
  /不能相同/,
  "起止相同要被拒，否则用户以为全天可发",
);

/* ---------- 闸门 ---------- */

const settings: GroupInitiativeSettings = {
  enabled: true,
  idleMinutes: 60,
  dailyMax: 3,
  minGapMinutes: 180,
  quietStart: "23:30",
  quietEnd: "07:30",
};

function gate(overrides: Partial<Parameters<typeof evaluateGroupInitiativeGate>[0]> = {}) {
  return evaluateGroupInitiativeGate({
    settings,
    now: cst(14),
    groupMode: "ambient",
    idleMinutes: 120,
    sentToday: 0,
    lastAttemptAt: null,
    quotaExceeded: false,
    ...overrides,
  });
}

assert.deepEqual(gate(), { allowed: true, reason: "ok" });

// 配置性问题优先于时间性问题：否则日志里全是「没到间隔」，真实原因是没开。
assert.deepEqual(gate({ settings: { ...settings, enabled: false }, idleMinutes: 1 }), {
  allowed: false,
  reason: "disabled",
});
assert.deepEqual(gate({ settings: { ...settings, dailyMax: 0 }, idleMinutes: 1 }), {
  allowed: false,
  reason: "daily_max_zero",
});
assert.equal(gate({ quotaExceeded: true, idleMinutes: 1 }).reason, "quota_exceeded");

assert.equal(gate({ sentToday: 3 }).reason, "daily_limit");
assert.equal(gate({ now: cst(23, 45) }).reason, "quiet_hours", "深夜不该叫醒一个群");
assert.equal(gate({ now: cst(7, 0) }).reason, "quiet_hours", "跨午夜的安静时段");
assert.equal(gate({ now: cst(7, 30) }).reason, "ok", "安静时段终点不含");

assert.equal(gate({ idleMinutes: 59 }).reason, "not_idle", "还没冷下来");
assert.equal(gate({ idleMinutes: 60 }).reason, "ok", "刚好到阈值就该放行");

// 「仅被 @ 时回复」的群不主动起话题：那是主人/群主对这个群的显式意图，
// 优先级压在额度与时间之前 —— 否则报个「额度用完」会把人指去查账。
assert.equal(gate({ groupMode: "mention" }).reason, "mention_only");
assert.equal(
  gate({ groupMode: "mention", quotaExceeded: true, now: cst(3), sentToday: 99, idleMinutes: 0 }).reason,
  "mention_only",
  "配置性原因要比额度/时间更早报出来",
);
assert.equal(gate({ groupMode: "mention", ignoreTimeGates: true }).reason, "mention_only", "试跑也不能绕过这条");
assert.equal(gate({ groupMode: "ambient" }).reason, "ok");
assert.equal(gate({ groupMode: "all" }).reason, "ok", "全都回的群当然能自己起头");

const attemptAt = new Date(cst(14).getTime() - 100 * 60_000);
assert.equal(gate({ lastAttemptAt: attemptAt }).reason, "min_gap", "100 分钟不够 180 的间隔");
assert.equal(
  gate({ lastAttemptAt: new Date(cst(14).getTime() - 180 * 60_000) }).reason,
  "ok",
  "满 180 分钟放行",
);

// 调试按钮：只跳时间类闸门。
assert.equal(gate({ ignoreTimeGates: true, idleMinutes: 0, now: cst(3), sentToday: 99 }).reason, "ok");
assert.equal(gate({ ignoreTimeGates: true, quotaExceeded: true }).reason, "quota_exceeded");
assert.equal(
  gate({ ignoreTimeGates: true, settings: { ...settings, enabled: false } }).reason,
  "disabled",
);
assert.equal(
  gate({ ignoreTimeGates: true, settings: { ...settings, dailyMax: 0 } }).reason,
  "daily_max_zero",
);

assert.equal(describeGroupInitiativeReason("ok"), "发出去了");
assert.equal(describeGroupInitiativeReason("not_idle"), "群里还没冷下来");
assert.equal(describeGroupInitiativeReason("mention_only"), "这个群设的是仅被 @ 时回复");
assert.equal(describeGroupInitiativeReason("weird_reason"), "weird_reason", "未知原因原样返回");

/* ---------- 时间格式 / 素材解析 ---------- */

assert.equal(clockLabelCst(cst(21, 5)), "21:05");
assert.equal(clockLabelCst(cst(0, 0)), "00:00");

assert.deepEqual(readRecentLines(null), []);
assert.deepEqual(readRecentLines("nonsense"), []);
assert.deepEqual(
  readRecentLines([
    { speaker: "小鱼", text: "吃饭了吗", at: 1 },
    { speaker: "", text: "还没", at: 2 },
    { speaker: "x", text: "   " },
    { nope: true },
  ]),
  ["小鱼：吃饭了吗", "群友：还没"],
);
const many = readRecentLines(Array.from({ length: 30 }, (_, i) => ({ speaker: "a", text: `m${i}` })));
assert.equal(many.length, 12, "素材最多 12 条");
assert.equal(many[0], "a：m0", "按时间正序，不是倒序");

/* ---------- 提示词硬约束 ---------- */

const systemPrompt = buildGroupInitiativeSystemPrompt("小鱼", "设定".repeat(10), "示例语气");
assert.match(systemPrompt, /不要 @ 任何人/, "群里不许点名");
assert.match(systemPrompt, /`-`/, "必须给「不说」的出口");
assert.match(systemPrompt, /30 个字/, "长度约束");
assert.doesNotMatch(systemPrompt, /私信/, "群里不是私聊");

const userPrompt = buildGroupInitiativeUserPrompt({
  groupLabel: "QQ群 123456",
  idleMinutes: 137,
  nowLabel: "21:30",
  recentLines: ["小鱼：吃饭了吗", "阿狸：还没"],
  memories: ["[PREFERENCE] 他喜欢吃辣"],
});
assert.match(userPrompt, /137 分钟/);
assert.match(userPrompt, /21:30/);
assert.match(userPrompt, /阿狸：还没/);
assert.doesNotMatch(
  buildGroupInitiativeUserPrompt({
    groupLabel: "QQ群 1",
    idleMinutes: 61,
    nowLabel: "09:00",
    recentLines: [],
    memories: [],
  }),
  /我记得的事/,
  "没有记忆时不要留空段落",
);

/* ---------- 活跃度记录器（不落库） ---------- */

async function testRecorder() {
  const written: Array<{ lastMessageAt: Date; lastSpokeAt: Date | null; recentLines: unknown[] }> = [];
  let clock = 1_000_000;
  const recorder = createGroupActivityRecorder({
    throttleMs: 20_000,
    now: () => clock,
    write: async (snapshot) => {
      written.push({
        lastMessageAt: snapshot.lastMessageAt,
        lastSpokeAt: snapshot.lastSpokeAt,
        recentLines: snapshot.recentLines,
      });
    },
  });

  const base = {
    bindingId: "b1",
    characterId: "c1",
    conversationId: "g:123456",
    groupId: "123456",
    speaker: "小鱼",
  };

  recorder.record({ ...base, at: clock, text: "第一条" });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(written.length, 1, "第一次见到这个群立刻落库");

  // 节流窗口内不写，但内存里的时间要跟上。
  clock += 5_000;
  recorder.record({ ...base, at: clock, text: "第二条" });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(written.length, 1, "20 秒内不重复落库");

  clock += 20_000;
  recorder.record({ ...base, at: clock, text: "第三条" });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(written.length, 2, "过了节流窗口再写");
  assert.equal(written[1]!.recentLines.length, 3, "被节流掉的消息不丢，一起补上");

  // 她说了话：立刻落库，并把 lastSpokeAt 带上。
  recorder.spoke({ bindingId: "b1", characterId: "c1", conversationId: "g:123456", groupId: "123456", at: clock });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(written.length, 3, "spoke 立刻落库");
  assert.equal(written[2]!.lastSpokeAt?.getTime(), clock);

  // 时间不能倒退（网关偶发乱序）。
  clock -= 60_000;
  recorder.record({ ...base, at: clock, text: "迟到的" });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(
    written[written.length - 1]!.lastMessageAt.getTime(),
    clock + 60_000,
    "旧时间戳不能把 lastMessageAt 拉回去",
  );

  assert.equal(recorder.size(), 1);
  recorder.record({ ...base, conversationId: "g:999", at: clock, text: "另一个群" });
  assert.equal(recorder.size(), 2);
}

await testRecorder();

console.log("group-initiative: 全部通过");
