import "dotenv/config";
import assert from "node:assert/strict";
import {
  BILI_WINDOWS,
  dueWindow,
  inWindow,
  remainingQuota,
  shouldRunDuty,
  toDayKey,
  windowDayKey,
  windowsRunFromTimestamps,
} from "../server/utils/channel-adapter/bili/duty-scheduler";
import { buildDutyPrompt } from "../server/utils/channel-adapter/bili/duty-prompt";
import { mergeOwnerFirst, pickOwnerCandidates } from "../server/utils/channel-adapter/bili/duty-pipeline";
import {
  BILI_DUTY_DEFAULTS,
  normalizeDmTargetUid,
  parseDutyInput,
  type BiliDutyConfig,
} from "../server/utils/channel-adapter/bili/configure";

function makeConfig(overrides: Partial<BiliDutyConfig> = {}): BiliDutyConfig {
  return { ...BILI_DUTY_DEFAULTS, ...overrides };
}

function makeDate(day: string, time: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  return new Date(y, m - 1, d, hh, mm, 0, 0);
}

async function main() {
  // 1. 谷时窗口定义（与 bili-desk 一致）
  assert.deepEqual(BILI_WINDOWS.noon, { start: "12:00", end: "14:00" });
  assert.deepEqual(BILI_WINDOWS.night, { start: "18:00", end: "09:00" });

  // 2. inWindow：中午窗口 12:00-14:00（左闭右开）
  assert.equal(inWindow("12:00", "noon"), true);
  assert.equal(inWindow("13:59", "noon"), true);
  assert.equal(inWindow("14:00", "noon"), false); // 右开
  assert.equal(inWindow("11:59", "noon"), false);

  // 3. inWindow：夜间窗口跨午夜 18:00-09:00
  assert.equal(inWindow("18:00", "night"), true);
  assert.equal(inWindow("23:59", "night"), true);
  assert.equal(inWindow("00:00", "night"), true);
  assert.equal(inWindow("08:59", "night"), true);
  assert.equal(inWindow("09:00", "night"), false); // 右开
  assert.equal(inWindow("12:00", "night"), false);

  // 4. dueWindow：中午窗口 + 该窗口今天没跑过 → 触发
  const cfg = makeConfig();
  const noon = dueWindow(makeDate("2026-10-25", "12:30"), cfg, { day: "2026-10-25", picked: 0, windowsRun: [] });
  assert.equal(noon, "noon");

  // 5. dueWindow：该窗口今天已跑过 → 不触发
  const done = dueWindow(makeDate("2026-10-25", "13:00"), cfg, { day: "2026-10-25", picked: 0, windowsRun: ["2026-10-25:noon"] });
  assert.equal(done, null);

  // 6. dueWindow：关闭中午窗口 → 不触发（但夜间窗口若开启仍可触发）
  const noNoon = dueWindow(makeDate("2026-10-25", "12:30"), makeConfig({ noon: false }), { day: "2026-10-25", picked: 0, windowsRun: [] });
  assert.equal(noNoon, null);

  // 7. shouldRunDuty：额度用完 → 不触发
  const noQuota = shouldRunDuty(makeDate("2026-10-25", "12:30"), makeConfig({ perDay: 3 }), { day: "2026-10-25", picked: 3, windowsRun: [] }, false);
  assert.equal(noQuota.due, false);
  assert.match(noQuota.reason, /额度已用完/);

  // 8. shouldRunDuty：正在跑 → 不触发
  const running = shouldRunDuty(makeDate("2026-10-25", "12:30"), cfg, { day: "2026-10-25", picked: 0, windowsRun: [] }, true);
  assert.equal(running.due, false);
  assert.match(running.reason, /还没跑完/);

  // 9. shouldRunDuty：窗口内 + 有额度 + 没跑过 + 没在跑 → 触发
  const go = shouldRunDuty(makeDate("2026-10-25", "12:30"), cfg, { day: "2026-10-25", picked: 0, windowsRun: [] }, false);
  assert.equal(go.due, true);
  assert.equal(go.window, "noon");

  // 10. remainingQuota / toDayKey
  assert.equal(remainingQuota(makeConfig({ perDay: 5 }), { day: "x", picked: 2, windowsRun: [] }), 3);
  assert.equal(toDayKey(new Date(2026, 9, 25)), "2026-10-25");

  // ---- 11. 跨午夜窗口归一（回归：老实现一个夜会跑两轮）----
  assert.equal(windowDayKey(makeDate("2026-10-26", "18:30"), "night"), "2026-10-26");
  assert.equal(windowDayKey(makeDate("2026-10-26", "23:59"), "night"), "2026-10-26");
  // 凌晨 0-9 点归到前一天，跟当晚 18:30 是同一个夜
  assert.equal(windowDayKey(makeDate("2026-10-27", "02:00"), "night"), "2026-10-26");
  assert.equal(windowDayKey(makeDate("2026-10-27", "08:59"), "night"), "2026-10-26");
  assert.equal(windowDayKey(makeDate("2026-10-27", "12:30"), "noon"), "2026-10-27");

  // 12. 从报告时间戳重建窗口标记
  assert.deepEqual(windowsRunFromTimestamps([makeDate("2026-10-26", "18:30")]), ["2026-10-26:night"]);
  assert.deepEqual(windowsRunFromTimestamps([makeDate("2026-10-26", "12:30")]), ["2026-10-26:noon"]);
  assert.deepEqual(windowsRunFromTimestamps([]), []);
  assert.deepEqual(windowsRunFromTimestamps([new Date("invalid")]), []);

  // 13. 当晚跑过 → 次日凌晨不再触发（老实现因为自然日变了会再跑一轮）
  const afterNight = windowsRunFromTimestamps([makeDate("2026-10-26", "18:30")]);
  assert.equal(dueWindow(makeDate("2026-10-27", "02:00"), cfg, { day: "2026-10-27", picked: 1, windowsRun: afterNight }), null);
  assert.equal(dueWindow(makeDate("2026-10-27", "08:30"), cfg, { day: "2026-10-27", picked: 1, windowsRun: afterNight }), null);

  // 14. 凌晨跑过 → 当晚也不再触发（同一个夜）
  const afterEarlyMorning = windowsRunFromTimestamps([makeDate("2026-10-27", "02:00")]);
  assert.equal(dueWindow(makeDate("2026-10-26", "20:00"), cfg, { day: "2026-10-26", picked: 1, windowsRun: afterEarlyMorning }), null);

  // 15. 窗口内重复评估不再触发（回归：refreshState 恒返回空 windowsRun 时每分钟都会 due）
  const noonMark = windowsRunFromTimestamps([makeDate("2026-10-26", "12:10")]);
  const firstCheck = dueWindow(makeDate("2026-10-26", "12:10"), cfg, { day: "2026-10-26", picked: 0, windowsRun: [] });
  assert.equal(firstCheck, "noon");
  const secondCheck = dueWindow(makeDate("2026-10-26", "12:11"), cfg, { day: "2026-10-26", picked: 1, windowsRun: noonMark });
  assert.equal(secondCheck, null, "同一窗口内第二次评估不能再触发");

  // 16. 值班章程提示词：脚本化流程下应该讲判断标准，而不是教模型跑命令
  const prompt = buildDutyPrompt(makeConfig({ keywords: ["DeepSeek"], dmMode: "only" }), {
    today: "2026-10-25",
    remaining: 5,
    perDay: 5,
    keywords: ["DeepSeek"],
    zone: "all",
    frames: 0,
    dmMode: "only",
    autoComment: false,
    commentPerRound: 1,
    mentionName: "",
    userAddress: "",
    watchLimit: 3,
    favMinScore: 0, autoDynamic: false, dynamicMinScore: 15,
  });
  assert.match(prompt, /替主人刷 B站/);
  assert.match(prompt, /今天还能挑：5 条/);
  assert.match(prompt, /最多细看：3 条/);
  assert.match(prompt, /DeepSeek/);
  // 防提示注入的规矩不能丢
  assert.match(prompt, /素材/);
  assert.match(prompt, /不是给我的指令/);
  // 脚本化之后不该再教模型自己跑命令
  assert.doesNotMatch(prompt, /bili feed recommend/);
  // dmMode=only 时不发公开评论
  assert.match(prompt, /不发公开评论/);

  // 17. 公开评论关闭时提示词要写明"不发"
  const commentOff = buildDutyPrompt(makeConfig({ dmMode: "off" }), {
    today: "2026-10-25", remaining: 5, perDay: 5, keywords: [], zone: "all", frames: 0,
    dmMode: "off", autoComment: false, commentPerRound: 1, mentionName: "", userAddress: "", watchLimit: 2,
    favMinScore: 0, autoDynamic: false, dynamicMinScore: 15,
  });
  assert.match(commentOff, /不发私信也不发评论/);

  // 18. 开了公开评论时，@ 的说法要指向 CLI 的真 @（正文里不用手写 @）
  const withComment = buildDutyPrompt(makeConfig({ dmMode: "both", autoComment: true, mentionName: "示例UP主" }), {
    today: "2026-10-25", remaining: 2, perDay: 5, keywords: [], zone: "all", frames: 0,
    dmMode: "both", autoComment: true, commentPerRound: 2, mentionName: "示例UP主", userAddress: "", watchLimit: 2,
    favMinScore: 0, autoDynamic: false, dynamicMinScore: 15,
  });
  assert.match(withComment, /@ 示例UP主/);
  assert.match(withComment, /真正的 @/);
  assert.match(withComment, /最多发 2 条评论/);
  assert.doesNotMatch(withComment, /正文第一句以/, "@ 的是别人、又没设称呼时，不该让她喊主人");

  // 18b. 评论里的称呼：设了称呼 + 开了 @，正文第一句才带称呼，而且只叫一次
  const addressed = buildDutyPrompt(makeConfig({ dmMode: "both", autoComment: true, mentionName: "owner" }), {
    today: "2026-10-25", remaining: 2, perDay: 5, keywords: [], zone: "all", frames: 0,
    dmMode: "both", autoComment: true, commentPerRound: 2, mentionName: "owner", userAddress: "爸爸", watchLimit: 2,
    favMinScore: 0, autoDynamic: false, dynamicMinScore: 15,
  });
  assert.match(addressed, /正文第一句以「爸爸，」开头/, "称呼要写在正文开头，@ 由脚本拼");
  assert.match(addressed, /整条只叫这一次/, "称呼要限制成一次，否则每条评论都在喊爸爸");
  assert.doesNotMatch(addressed, /别提主人/, "@ 到自己人时不该再说「别提主人」");

  // 18c. 没开 @ 就不叫称呼：公开评论是给陌生人看的，喊一声没人知道在叫谁
  const noMention = buildDutyPrompt(makeConfig({ dmMode: "both", autoComment: true, mentionName: "" }), {
    today: "2026-10-25", remaining: 2, perDay: 5, keywords: [], zone: "all", frames: 0,
    dmMode: "both", autoComment: true, commentPerRound: 2, mentionName: "", userAddress: "爸爸", watchLimit: 2,
    favMinScore: 0, autoDynamic: false, dynamicMinScore: 15,
  });
  assert.doesNotMatch(noMention, /正文第一句以/, "不 @ 任何人时不该出现称呼要求");
  assert.match(noMention, /别提爸爸/, "不 @ 时仍然保持「别提称呼」的口径，且称呼跟着换成设定的那个");

  // 18d. 叙述里的「主人」也跟着称呼走：没设称呼时才回到「主人」
  assert.match(addressed, /替爸爸刷 B站/, "设了称呼，整份章程里的「主人」都要换掉");
  assert.match(addressed, /占爸爸的注意力/);
  assert.doesNotMatch(addressed, /主人/, "换掉之后不该再冒出「主人」这个词");
  assert.match(prompt, /替主人刷 B站/, "没设称呼时保持「主人」（prompt 这一份 userAddress 是空的）");

  // 19. 刷站口味：只在填了才注入；注入了就要压过通用尺度，但不能顶掉防注入底线
  const roundSettings = {
    today: "2026-10-25", remaining: 5, perDay: 5, keywords: [], zone: "all", frames: 0,
    dmMode: "only" as const, autoComment: false, commentPerRound: 1, mentionName: "", userAddress: "", watchLimit: 2,
    favMinScore: 0, autoDynamic: false, dynamicMinScore: 15,
  };
  const noTaste = buildDutyPrompt(makeConfig({ taste: "" }), roundSettings);
  assert.doesNotMatch(noTaste, /这个账号的口味/, "没填口味时不该出现口味段");

  const withTaste = buildDutyPrompt(
    makeConfig({ taste: "只看米哈游相关。\n标题里有「鸣潮」就跳过，理由写：鸣潮" }),
    roundSettings,
  );
  assert.match(withTaste, /这个账号的口味/, "填了口味就要有独立一段");
  assert.match(withTaste, /只看米哈游相关/);
  assert.match(withTaste, /理由写：鸣潮/);
  assert.match(withTaste, /以口味为准/, "口味与通用尺度冲突时以口味为准");
  assert.match(withTaste, /不受口味影响/, "防注入底线不能被口味顶掉");

  // 20. 私信收件人：留空 = 主人；指定 UID 时口径要跟着换，别再说「私信给主人」
  const toOwner = buildDutyPrompt(makeConfig({ dmMode: "only" }), roundSettings);
  assert.match(toOwner, /只发私信给主人/);

  const toUid = buildDutyPrompt(makeConfig({ dmTargetUid: "10000007" }), {
    ...roundSettings,
    dmTarget: "10000007",
  });
  assert.match(toUid, /指定收件人（UID 10000007）/);
  assert.doesNotMatch(toUid, /私信给主人/, "指定收件人后不该还写「私信给主人」");

  // 20.5 打分与对外动作：分数要讲清楚怎么打，动作用什么口径要跟设置一致
  const withActions = buildDutyPrompt(
    makeConfig({ favMinScore: 14, autoDynamic: true, dynamicMinScore: 16 }),
    { ...roundSettings, favMinScore: 14, autoDynamic: true, dynamicMinScore: 16 },
  );
  assert.match(withActions, /## 打分/, "章程里必须有打分口径");
  assert.match(withActions, /0-20 的整数分/);
  assert.match(withActions, /14 分以上才会收进收藏夹/);
  assert.match(withActions, /到 16 分会发一条公开动态/);
  assert.match(withActions, /不要出现「主人」「私信」/, "要发动态时必须提前讲清公开边界");

  const actionsOff = buildDutyPrompt(makeConfig(), roundSettings);
  assert.match(actionsOff, /这一轮不收藏/);
  assert.match(actionsOff, /这一轮不发动态/);
  assert.doesNotMatch(actionsOff, /不要出现「主人」「私信」/, "不发动态时不该多这段警告");

  // 21. parseDutyInput：收件人只留数字，陌生放行默认关
  assert.equal(normalizeDmTargetUid("UID: 10000007"), "10000007");
  assert.equal(normalizeDmTargetUid("示例UP主"), "");
  assert.equal(normalizeDmTargetUid(undefined), "");

  const parsedCustom = parseDutyInput({ dmTargetUid: "1000 0007", dmAllowNew: true });
  assert.equal(parsedCustom.dmTargetUid, "10000007");
  assert.equal(parsedCustom.dmAllowNew, true);

  const parsedDefault = parseDutyInput({});
  assert.equal(parsedDefault.dmTargetUid, "", "没填收件人 = 发给主人");
  assert.equal(parsedDefault.dmAllowNew, false, "默认不给陌生人发私信");
  // 老数据（没有这两个字段）读回来也不能变成「发给 UID 空字符串」
  assert.equal(parseDutyInput({ taste: "只看米哈游" }).dmTargetUid, "");
  // 对外动作：默认全关，越界值要夹住
  const actionDefaults = parseDutyInput({});
  assert.equal(actionDefaults.favMinScore, 0, "默认不收藏");
  assert.equal(actionDefaults.autoDynamic, false, "默认不发动态");
  assert.equal(actionDefaults.dynamicMinScore, 15);
  const actionClamped = parseDutyInput({ favMinScore: 99, dynamicMinScore: -3 });
  assert.equal(actionClamped.favMinScore, 20, "收藏阈分夹到 0-20");
  assert.equal(actionClamped.dynamicMinScore, 0, "动态阈分同样夹住");

  // 日报档位与今日额度重置：默认薄版、没重置过；非法值回默认
  assert.equal(parseDutyInput({}).reportLevel, "brief");
  assert.equal(parseDutyInput({ reportLevel: "full" }).reportLevel, "full");
  assert.equal(parseDutyInput({ reportLevel: "off" }).reportLevel, "off");
  assert.equal(parseDutyInput({ reportLevel: "nonsense" }).reportLevel, "brief");
  assert.equal(parseDutyInput({}).quotaResetAt, "");
  assert.equal(
    parseDutyInput({ quotaResetAt: "2026-10-29T08:00:00Z" }).quotaResetAt,
    "2026-10-29T08:00:00.000Z",
  );
  assert.equal(parseDutyInput({ quotaResetAt: "not-a-date" }).quotaResetAt, "");

  // 主人优先：主人发的东西她一定看，不能交给粗筛决定
  // 模型一条都没留，主人那条照样进（这是「优先」的底线）
  assert.deepEqual(mergeOwnerFirst(["BVowner"], [], 3), ["BVowner"]);
  // 排在被模型挑中的前面
  assert.deepEqual(mergeOwnerFirst(["BVowner"], ["BVx", "BVy"], 3), ["BVowner", "BVx", "BVy"]);
  // 模型也留了同一条 → 不重复
  assert.deepEqual(mergeOwnerFirst(["BVowner"], ["BVowner", "BVx"], 3), ["BVowner", "BVx"]);
  // 主人连发三条，只补 2 条（OWNER_PICK_MAX）—— 不能把一整轮占满
  assert.deepEqual(mergeOwnerFirst(["BVa", "BVb", "BVc"], [], 5), ["BVa", "BVb"]);
  // 额度紧到 watchLimit=1 时，主人那两条也不能被挤掉
  assert.deepEqual(mergeOwnerFirst(["BVa", "BVb"], ["BVx"], 1), ["BVa", "BVb"]);

  // 主人相关开关：两个总开关默认都关，投币门槛默认 12
  assert.equal(parseDutyInput({}).ownerFirst, false);
  assert.equal(parseDutyInput({}).ownerWatch, false);
  assert.equal(parseDutyInput({ ownerFirst: true }).ownerFirst, true);
  assert.equal(parseDutyInput({ ownerWatch: true }).ownerWatch, true);
  assert.equal(parseDutyInput({}).ownerCoinMinScore, 12);
  assert.equal(parseDutyInput({ ownerCoinMinScore: 99 }).ownerCoinMinScore, 20, "投币门槛夹到 0-20");
  // 只开 ownerFirst 不该把互动那四项带开
  const firstOnly = parseDutyInput({ ownerFirst: true });
  assert.equal(firstOnly.ownerWatch, false, "ownerFirst 和 ownerWatch 互不牵连");

  // 主人优先的时间窗：最近 30 天；一条都没有时退回最近 3 条
  const now = Date.parse("2026-11-02T12:00:00+08:00");
  const daysAgo = (n: number) => new Date(now - n * 86400000).toISOString();
  const allFresh = [{ pubdate: daysAgo(1) }, { pubdate: daysAgo(3) }];
  assert.deepEqual(pickOwnerCandidates(allFresh, now).picked, allFresh, "都在 30 天内 → 全取");
  assert.equal(pickOwnerCandidates(allFresh, now).fellBack, false);
  // 混着去年 1 月的：只取窗口内的，不能把去年的当「这轮刷到的」
  const mixed = [{ pubdate: daysAgo(1) }, { pubdate: "2025-01-19T15:19:21+08:00" }];
  assert.deepEqual(pickOwnerCandidates(mixed, now).picked, [mixed[0]]);
  // 全是老的 → 退回最近 3 条，并标记 fellBack（报告里要说明）
  const allOld = [{ pubdate: daysAgo(400) }, { pubdate: daysAgo(500) }, { pubdate: daysAgo(600) }, { pubdate: daysAgo(700) }];
  const fallback = pickOwnerCandidates(allOld, now);
  assert.equal(fallback.picked.length, 3, "兜底只取 3 条，不是全取");
  assert.equal(fallback.fellBack, true);
  // 日期解析不出来的一律保留 —— 接口字段一变不能把主人的视频全滤掉
  assert.deepEqual(pickOwnerCandidates([{ pubdate: "" }], now).picked, [{ pubdate: "" }]);
  // 空列表就是空，不要造兜底
  assert.deepEqual(pickOwnerCandidates([], now).picked, []);
  assert.equal(pickOwnerCandidates([], now).fellBack, false);

  console.log("✅ test-bili-duty 全部通过");
  console.log("   谷时窗口判断（含跨午夜）：通过");
  console.log("   跨午夜归一 / 从报告重建窗口标记：通过");
  console.log("   额度 / 去重 / 运行态判断：通过");
  console.log("   值班章程提示词：通过");
  console.log("   刷站口味注入（空/有/底线不被顶掉）：通过");
  console.log("   私信收件人（主人 / 指定 UID）与陌生放行：通过");
  console.log("   打分口径 / 收藏与发动态闸门：通过");
  console.log("   主人优先（模型没留也进 / 上限 2 条 / 不被额度挤掉）：通过");
  console.log("   主人优先的时间窗（30 天 / 全老退回 3 条 / 空日期保留）：通过");
}

main().catch((error) => {
  console.error("❌ test-bili-duty 失败：", error);
  process.exit(1);
});
