/**
 * 群聊「自然接话」的纯逻辑测试：配置解析、闸门顺序、名字识别、攒批行为。
 *
 * 都不连数据库、不调模型 —— 这几件事全是纯函数，跑一次几百毫秒。
 * 端到端（真的收到消息、真的发出去）在 test-onebot-adapter.ts 里。
 */

import assert from "node:assert/strict";
import {
  FOLLOWUP_MIN_GAP_MS,
  FOLLOWUP_WINDOW_MS,
  GROUP_CHAT_DEFAULTS,
  createGroupChatBuffer,
  evaluateGroupChatGate,
  groupChatDayStart,
  groupChatForGroup,
  groupChatWindowMs,
  isClarificationMessage,
  isGroupId,
  isAiOnlyGroupRound,
  mentionsCharacterName,
  shouldBlockFriendSpeaker,
  shouldPauseAiOnlyRound,
  nextConsecutiveAiRounds,
  MAX_CONSECUTIVE_AI_ROUNDS,
  readGroupChatModeOverrides,
  resolveGroupChatSettings,
  type GroupChatGateInput,
} from "../server/utils/channel-adapter/onebot/group-chat";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ── 1. 配置解析 ─────────────────────────────────────────
assert.equal(GROUP_CHAT_DEFAULTS.mode, "ambient", "默认档是自然接话，不是全都回。");

// 老字段兜底：连接级说「仅 @」，绑定没写就跟着走。
assert.equal(resolveGroupChatSettings({}, true).mode, "mention");
// 老字段 false 以前表示「全都回」，现在解释成 ambient —— 那个行为正是要修掉的。
assert.equal(resolveGroupChatSettings({}, false).mode, "ambient");
assert.equal(resolveGroupChatSettings({ replyOnlyWhenMentioned: false }, true).mode, "ambient");
assert.equal(resolveGroupChatSettings({ replyOnlyWhenMentioned: true }, false).mode, "mention");
// 显式写了 mode 就听绑定的。
assert.equal(resolveGroupChatSettings({ groupChatMode: "all", replyOnlyWhenMentioned: true }, true).mode, "all");
assert.equal(resolveGroupChatSettings({ groupChatMode: "nonsense" }, true).mode, "mention");

const tuned = resolveGroupChatSettings({
  groupChatMode: "ambient",
  batchWindowSeconds: 999,
  mentionWindowSeconds: 0,
  minGapSeconds: -5,
  dailyMax: 99999,
  ambientChance: 3,
  quietStart: "7:5",
  quietEnd: "25:00",
  groupAliases: " 小鱼，汐汐  小汐 小鱼 ",
}, true);
assert.equal(tuned.batchWindowSeconds, 60, "攒批窗口夹到 60 秒以内。");
assert.equal(tuned.mentionWindowSeconds, 1, "被 @ 的窗口最少 1 秒。");
assert.equal(tuned.minGapSeconds, 0, "间隔不能是负数。");
assert.equal(tuned.dailyMax, 1000);
assert.equal(tuned.ambientChance, 1, "概率夹到 0-1。");
assert.equal(tuned.quietStart, "07:05", "手填的 7:5 要归一成 07:05。");
assert.equal(tuned.quietEnd, GROUP_CHAT_DEFAULTS.quietEnd, "非法时间回落默认值。");
assert.deepEqual(tuned.aliases, ["小鱼", "汐汐", "小汐"], "别名去重、去空白、保留顺序。");
assert.deepEqual(resolveGroupChatSettings({ groupAliases: ["a", "b"] }).aliases, ["a", "b"], "数组形式的别名也认。");

// ── 2. 名字识别 ─────────────────────────────────────────
assert(mentionsCharacterName("小鱼在吗", ["小鱼"]));
assert(mentionsCharacterName("小 鱼 在吗", ["小鱼"]), "中间有空格也要认出来。");
assert(mentionsCharacterName("DeepSeek阿汐 你好", ["deepseek阿汐"]), "大小写不敏感。");
assert(!mentionsCharacterName("今天吃鱼", ["小鱼"]), "别把「吃鱼」当成在叫她。");
assert(!mentionsCharacterName("", ["小鱼"]));

// ── 3. 澄清识别 ─────────────────────────────────────────
// 「没说你呢」是群里最常见的递台阶，程序层面却和「点名叫她」长得一样（都是 at 段指向她）。
// 认出来后只是**允许沉默**，不是让她一定闭嘴。
assert(isClarificationMessage("没说你呢"), "「没说你呢」是澄清。");
assert(isClarificationMessage("不是说你啊，别往心里去"), "「不是说你」也是。");
assert(isClarificationMessage("[CQ:at,qq=123] 我说的是别人"), "@ 段要剥掉再判，别让 CQ 码把长度撑爆。");
assert(isClarificationMessage("别误会"), "「别误会」是同一类。");
assert(isClarificationMessage("跟你没关系"), "撇清关系的话同样算。");
assert(!isClarificationMessage("那你说说看"), "普通提问不是澄清。");
assert(!isClarificationMessage("没说你呢，你那边迁移是怎么做的，我这边要适配一下新协议"), "长句里后面还跟着正事 —— 必须回，不能当澄清。");
assert(!isClarificationMessage(""), "空正文无从判断。");

// ── 4. 闸门 ─────────────────────────────────────────────
const base = {
  settings: { ...GROUP_CHAT_DEFAULTS },
  now: new Date("2026-10-29T15:00:00+08:00"),
  direct: false,
  named: false,
  topicCandidate: false,
  lastSpokeAt: null,
  spokenToday: 0,
  random: 0.9,
} satisfies GroupChatGateInput;

const gate = (patch: Partial<GroupChatGateInput>) => evaluateGroupChatGate({ ...base, ...patch });

assert.deepEqual(
  gate({ settings: { ...GROUP_CHAT_DEFAULTS, mode: "mention" } }),
  { allowed: false, reason: "not_cued", mustReply: false },
);
assert.deepEqual(
  gate({ settings: { ...GROUP_CHAT_DEFAULTS, mode: "mention" }, direct: true }),
  { allowed: true, reason: "direct", mustReply: true },
  "被 @ 时不允许沉默。",
);
// 被澄清是唯一能让「@ 了也不强制回」成立的情况：放行照旧，但说不说交回给她。
// 逼一个刚被递台阶的人必须开口，她只会把台阶踢回去。
assert.deepEqual(
  gate({ settings: { ...GROUP_CHAT_DEFAULTS, mode: "mention" }, direct: true, clarificationOnly: true }),
  { allowed: true, reason: "clarification", mustReply: false },
  "被澄清的 @ 放行但允许沉默。",
);
assert.equal(
  gate({ settings: { ...GROUP_CHAT_DEFAULTS, mode: "all" }, direct: true, clarificationOnly: true }).mustReply,
  true,
  "「全都回」不受理这条例外：用户显式选了每句都接，语气由提示词兜，模式不该被偷偷改掉。",
);
assert.deepEqual(
  gate({ settings: { ...GROUP_CHAT_DEFAULTS, mode: "mention" }, named: true }),
  { allowed: true, reason: "named", mustReply: false },
  "mention 档里名字只是弱线索：可以看一眼，但允许沉默。",
);
assert.deepEqual(
  gate({ settings: { ...GROUP_CHAT_DEFAULTS, mode: "all" } }),
  { allowed: true, reason: "all_messages", mustReply: true },
);
assert.equal(
  gate({ settings: { ...GROUP_CHAT_DEFAULTS, mode: "all" }, random: 1 }).allowed,
  true,
  "「全都回」是用户显式选的，不叠安静时段和上限。",
);

// all 档唯一的例外：有人 @ 的是**别的成员**、没 @ 她也没叫她的名字。
// 「全都回」= 群里说什么都愿意搭一句，不是「别人的私事也插嘴」。
assert.deepEqual(
  gate({ settings: { ...GROUP_CHAT_DEFAULTS, mode: "all" }, addressedToOthers: true }),
  { allowed: false, reason: "addressed_to_others", mustReply: false },
  "@ 别人的私事不接。",
);
assert.equal(
  gate({ settings: { ...GROUP_CHAT_DEFAULTS, mode: "all" }, addressedToOthers: true, direct: true }).allowed,
  true,
  "@ 她的同时也 @ 了别人：那是 direct，照旧要回。",
);
assert.equal(
  gate({ settings: { ...GROUP_CHAT_DEFAULTS, mode: "all" }, addressedToOthers: true, named: true }).allowed,
  true,
  "@ 别人但正文叫到她的名字：可以回。",
);
assert.equal(
  gate({ settings: { ...GROUP_CHAT_DEFAULTS, mode: "ambient" }, addressedToOthers: true }).allowed,
  false,
  "自然接话档本来就不回无关消息，这个字段对它没有副作用。",
);

const night = new Date("2026-10-29T23:45:00+08:00");
assert.equal(gate({ now: night }).reason, "quiet_hours", "安静时段不主动接话。");
assert.equal(gate({ now: night, direct: true }).reason, "direct", "被 @ 时安静时段也要回。");
assert.equal(gate({ now: night, named: true }).reason, "quiet_hours", "名字命中不能绕过安静时段。");

assert.equal(gate({ spokenToday: GROUP_CHAT_DEFAULTS.dailyMax }).reason, "daily_limit");
assert.equal(gate({ spokenToday: GROUP_CHAT_DEFAULTS.dailyMax, direct: true }).reason, "daily_limit", "到了当天上限，点名也不回。");

// ── 4b. 接话：她刚说过话，别人接着回 ─────────────────────
// 旧逻辑只把 lastSpokeAt 当节流用，于是「她开了个头、群友顺着说一句」被算成不相关，
// 只剩 0.15 的抽签 —— 八成半的接话她根本看不见。主动开口（group-initiative）发的消息
// 也是 ASSISTANT 消息落进同一个群会话，所以同一个判据能一并覆盖它。
assert(FOLLOWUP_MIN_GAP_MS < GROUP_CHAT_DEFAULTS.minGapSeconds * 1000, "接话下限必须比常规间隔短，否则这条规则没有意义。");
assert(FOLLOWUP_WINDOW_MS > FOLLOWUP_MIN_GAP_MS, "窗口要容得下至少一次接话。");

const tenSecondsAgo = new Date(base.now.getTime() - 10 * 1000);
const justSpoke = new Date(base.now.getTime() - 30 * 1000);

assert.equal(
  gate({ lastSpokeAt: tenSecondsAgo }).reason,
  "too_soon",
  "刚说完 10 秒又来一轮：仍要压住，别连发。",
);
assert.deepEqual(
  gate({ lastSpokeAt: justSpoke }),
  { allowed: true, reason: "continuing", mustReply: false },
  "她 30 秒前说过话、有人接一句（没 @ 她也没叫她名字）：这是同一段对话的来回，该送进去看一眼。",
);
assert.deepEqual(
  gate({ lastSpokeAt: justSpoke, topicCandidate: false, random: GROUP_CHAT_DEFAULTS.ambientChance }),
  { allowed: true, reason: "continuing", mustReply: false },
  "接话不靠抽签：random 等于阈值（非命中）时也要放行。",
);
assert.equal(
  gate({ lastSpokeAt: new Date(base.now.getTime() - 100 * 1000), random: 0.9, addressedToOthers: true }).reason,
  "not_relevant",
  "有人 @ 别人办事：她刚说完话也不凑上去，接话窗口不生效。",
);

// 边界：窗口内算接话，出了窗口退回普通抽签。
assert.equal(
  gate({ lastSpokeAt: new Date(base.now.getTime() - FOLLOWUP_WINDOW_MS) }).reason,
  "continuing",
  "刚好在窗口边上仍算接话（闭区间，避免浮点误差把边界吃掉）。",
);
assert.equal(
  gate({ lastSpokeAt: new Date(base.now.getTime() - FOLLOWUP_WINDOW_MS - 60 * 1000) }).reason,
  "not_relevant",
  "出了窗口 3 分钟以上：话题不相关、抽签也没中，就该潜水。",
);

// 接话只是「相关性」的弱线索，不能拿去绕过任何硬闸门。
assert.equal(
  gate({ now: new Date(night.getTime() - 30 * 1000), lastSpokeAt: new Date(night.getTime() - 60 * 1000) }).reason,
  "quiet_hours",
  "接话不能绕过安静时段。",
);
assert.equal(
  gate({ spokenToday: GROUP_CHAT_DEFAULTS.dailyMax, lastSpokeAt: justSpoke }).reason,
  "daily_limit",
  "接话不能绕过每日上限。",
);
assert.equal(
  gate({ settings: { ...GROUP_CHAT_DEFAULTS, mode: "mention" }, lastSpokeAt: justSpoke }).reason,
  "not_cued",
  "「仅 @ 时回复」是用户对这个群的显式意图，接话也不例外。",
);

// 回归：2026-10-30 线上，她 10:32:12 回完一句，10:32:48 有人 @ 她，
// 36 秒 < minGap 90 秒，被判 too_soon 丢掉，人看到的现象就是「@ 了也不回」。
assert.deepEqual(
  gate({ lastSpokeAt: justSpoke, direct: true }),
  { allowed: true, reason: "direct", mustReply: true },
  "刚说完话又被 @ 了：必须回，间隔不能压过点名。",
);
assert.equal(
  gate({ lastSpokeAt: tenSecondsAgo, named: true }).reason,
  "too_soon",
  "只是正文里叫到名字，仍要受间隔约束 —— 群里同款鱼太多，名字是弱线索。",
);
assert.equal(
  gate({ lastSpokeAt: new Date(base.now.getTime() - 5 * 60 * 1000) }).reason,
  "not_relevant",
  "错过接话窗口之后，话题不相关、抽签也没中，就该潜水。",
);

assert.deepEqual(
  gate({ topicCandidate: true }),
  { allowed: true, reason: "topic", mustReply: false },
  "接着她参与过的话题说，可以看一眼，但仍允许沉默。",
);
assert.equal(gate({ random: 0 }).reason, "chance", "抽签命中就放进去看一眼。");
assert.equal(
  gate({ random: GROUP_CHAT_DEFAULTS.ambientChance }).reason,
  "not_relevant",
  "等于阈值不算中（避免边界上浮点抖动导致概率偏移）。",
);

// 攒批窗口：被 @ / 叫到名字用短窗口；all 也要快；其余用整轮窗口。
assert.equal(groupChatWindowMs(GROUP_CHAT_DEFAULTS, true), GROUP_CHAT_DEFAULTS.mentionWindowSeconds * 1000);
assert.equal(groupChatWindowMs(GROUP_CHAT_DEFAULTS, false), GROUP_CHAT_DEFAULTS.batchWindowSeconds * 1000);
assert.equal(
  groupChatWindowMs({ ...GROUP_CHAT_DEFAULTS, mode: "all", mentionWindowSeconds: 9 }, false),
  3_000,
  "all 档最多等 3 秒，不能变成「等一整轮」。",
);

// ── 5. 攒批 ─────────────────────────────────────────────
const flushed: Array<{ key: string; items: number[] }> = [];
const buffer = createGroupChatBuffer<{ at: number; n: number }>({
  onFlush: (key, items) => {
    flushed.push({ key, items: items.map((item) => item.n) });
  },
  maxItems: 3,
});

buffer.push("g:1", { at: Date.now(), n: 1 }, 250);
buffer.push("g:1", { at: Date.now(), n: 2 }, 250);
buffer.push("g:2", { at: Date.now(), n: 9 }, 250);
assert.equal(buffer.size("g:1"), 2);
await sleep(400);
assert.deepEqual(
  flushed.map((entry) => entry.key).sort(),
  ["g:1", "g:2"],
  "不同群各自成批，互不等待。",
);
assert.deepEqual(flushed.find((entry) => entry.key === "g:1")?.items, [1, 2]);

buffer.push("g:3", { at: Date.now(), n: 1 }, 5_000);
buffer.push("g:3", { at: Date.now(), n: 2 }, 5_000);
buffer.push("g:3", { at: Date.now(), n: 3 }, 5_000);
buffer.push("g:3", { at: Date.now(), n: 4 }, 5_000);
assert.equal(buffer.size("g:3"), 3, "一批最多留 maxItems 条，超出丢最早的。");
buffer.drain("g:3");
await sleep(10);
assert.deepEqual(flushed.find((entry) => entry.key === "g:3")?.items, [2, 3, 4], "丢掉最早的那条，其余按顺序。");

// 冲掉之后不能重复投递。
const before = flushed.length;
buffer.drain("g:3");
await sleep(10);
assert.equal(flushed.length, before, "空批次不再回调。");

// ── 6. 日界 ─────────────────────────────────────────────
assert.equal(
  groupChatDayStart(new Date("2026-10-29T00:30:00+08:00")).toISOString(),
  "2026-10-28T16:00:00.000Z",
  "按东八区算当天零点。",
);

// ── 7. 按群覆盖模式 ────────────────────────────────────
// 一条绑定挂多个群时，各群的「存在感」不一样：大群只看被 @，小群随便聊。
const bindSettings = resolveGroupChatSettings({ groupChatMode: "ambient", minGapSeconds: 300, dailyMax: 30 }, true);
const overrides = readGroupChatModeOverrides({ "10000005": "mention", "10000004": "all" });
assert.deepEqual(overrides, { "10000005": "mention", "10000004": "all" });

// 只改 mode：节奏参数仍跟绑定走，否则同一份配置会出现两种「间隔」说法。
const forSmallGroup = groupChatForGroup(bindSettings, overrides, "10000004");
assert.equal(forSmallGroup.mode, "all");
assert.equal(forSmallGroup.minGapSeconds, 300);
assert.equal(forSmallGroup.dailyMax, 30);
assert.equal(bindSettings.mode, "ambient", "覆盖不能就地改原设置：别的群还在用它。");

// 没单独设过的群、私聊（没有群号）都沿默认档。
assert.equal(groupChatForGroup(bindSettings, overrides, "888888888").mode, "ambient");
assert.equal(groupChatForGroup(bindSettings, overrides, null).mode, "ambient");
assert.equal(groupChatForGroup(bindSettings, {}, "10000005").mode, "ambient");
assert.equal(groupChatForGroup(bindSettings, undefined, "10000005").mode, "ambient");

// 闸门拿到的是覆盖后那一档：设成 mention 的群，没 @ 就不看。
assert.deepEqual(
  gate({ settings: groupChatForGroup(bindSettings, overrides, "10000005") }),
  { allowed: false, reason: "not_cued", mustReply: false },
);
assert.equal(
  gate({ settings: groupChatForGroup(bindSettings, overrides, "10000004") }).reason,
  "all_messages",
  "同一个绑定里，设成「全都回」的群仍走老行为。",
);

// 脏表不让整份失效：坏群号、坏档位跳过，好的照留。
assert.deepEqual(
  readGroupChatModeOverrides({ "10000005": "mention", "abc": "all", "10000004": "loud", " 123456 ": "all" }),
  { "10000005": "mention", "123456": "all" },
  "非群号与非法档位被跳过，群号两端空白要清掉。",
);
assert.deepEqual(readGroupChatModeOverrides(null), {});
assert.deepEqual(readGroupChatModeOverrides(["x"]), {}, "数组不是「群号 → 模式」表，按空处理。");
assert.equal(isGroupId("10000005"), true);
assert.equal(isGroupId("123"), false, "太短的不当群号。");
assert.equal(isGroupId("1000000512345"), false, "超过 12 位的不是群号。");

// 上限：一张表最多 50 个群，多的截掉（写入接口也卡这个数）。
const manyGroups = Object.fromEntries(
  Array.from({ length: 60 }, (_, index) => [String(100000000 + index), "all" as const]),
);
assert.equal(Object.keys(readGroupChatModeOverrides(manyGroups)).length, 50);

// ── 8. 朋友身份与 AI 对话保护 ──────────────────────────
assert.equal(shouldBlockFriendSpeaker("AI", "DEFAULT"), true, "AI 默认不接话。");
assert.equal(shouldBlockFriendSpeaker("AI", "ALLOW"), false, "明确允许的 AI 朋友可以交流。");
assert.equal(shouldBlockFriendSpeaker("AI", "BLOCK"), true, "明确禁止优先阻止 AI。");
assert.equal(shouldBlockFriendSpeaker("HUMAN", "DEFAULT"), false, "真人默认正常交流。");
assert.equal(shouldBlockFriendSpeaker("HUMAN", "BLOCK"), true, "禁止规则同样适用于真人。");
assert.equal(shouldBlockFriendSpeaker("UNKNOWN", "DEFAULT"), false, "未知身份保留旧行为。");
assert.equal(shouldBlockFriendSpeaker("UNKNOWN", "BLOCK"), true, "未知对象也可以被手动禁止。");
assert.equal(shouldBlockFriendSpeaker("UNKNOWN", "ALLOW"), false, "允许规则不依赖自动分类。");

assert.equal(isAiOnlyGroupRound(["AI"]), true);
assert.equal(isAiOnlyGroupRound(["AI", "AI"]), true);
assert.equal(isAiOnlyGroupRound(["AI", "UNKNOWN"]), false, "未知身份不冒充已确认 AI。");
assert.equal(isAiOnlyGroupRound(["AI", "HUMAN"]), false, "真人参与会打断连续 AI 轮次。");
assert.equal(isAiOnlyGroupRound([]), false, "空批次不能计数。");
assert.equal(nextConsecutiveAiRounds(2, ["AI"]), 3, "纯 AI 轮次应递增连续计数。");
assert.equal(nextConsecutiveAiRounds(2, ["AI", "AI"]), 3);
assert.equal(nextConsecutiveAiRounds(2, ["HUMAN"]), 0, "真人参与应清零连续计数。");
assert.equal(nextConsecutiveAiRounds(2, ["HUMAN", "AI"]), 0, "真人参与的混合轮次也应清零。");
assert.equal(nextConsecutiveAiRounds(2, ["UNKNOWN"]), 2, "未知身份不能冒充真人清零。");
assert.equal(nextConsecutiveAiRounds(2, ["AI", "UNKNOWN"]), 2, "混入未知身份时既不误计 AI，也不清空已有保护。");
assert.equal(nextConsecutiveAiRounds(2, []), 2, "空轮次不能改变计数。");
assert.equal(nextConsecutiveAiRounds(-5, ["UNKNOWN"]), 0, "历史异常负数按零处理。");
assert.equal(nextConsecutiveAiRounds(Number.NaN, ["AI"]), 1, "异常计数按零开始。");
assert.equal(MAX_CONSECUTIVE_AI_ROUNDS, 3);
assert.equal(shouldPauseAiOnlyRound(0), false);
assert.equal(shouldPauseAiOnlyRound(2), false);
assert.equal(shouldPauseAiOnlyRound(3), true, "连续三轮 AI 后暂停下一轮。");
assert.equal(shouldPauseAiOnlyRound(10), true);

console.log("群聊自然接话测试通过：配置解析与夹取、别名识别、澄清识别、闸门顺序（模式/安静时段/上限/间隔/direct/名字弱线索/接话窗口/话题候选/抽签）、@ 的是别人时「全都回」也不抢话、被澄清的 @ 允许沉默、mustReply 边界、攒批窗口与合并上限、东八区日界、按群覆盖模式。");
