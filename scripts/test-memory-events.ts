import assert from "node:assert/strict";
import {
  localDayHour, localDayKey, parseEventTimeRange, resolveDailyEventWindow, resolveDayWindow, zonedDateTime,
} from "../server/utils/memory-event-time";
import {
  RAW_MESSAGE_MAX_CHARS, RAW_MESSAGE_TOKEN_BUDGET_DEFAULT, selectRawMessagesForPrompt,
} from "../server/utils/message-retrieval";
import { estimateTokens } from "../server/utils/memory-retrieval";
import { toMemoryTimelineDtos } from "../server/utils/memory-timeline-dto";
import { parseEventParticipantIdQuery, selectEventsForPrompt } from "../server/utils/memory-event-retrieval";
import { isNearDuplicateEvent, longestCommonSubstringLength, makeEventDedupeKey } from "../server/utils/memory-ai";

const TZ = "Asia/Shanghai";
// 2026-10-31 是周六，用固定的「现在」做断言，避免测试随日期漂移。
const now = new Date("2026-10-31T14:00:00+08:00");
const at = (iso: string) => new Date(iso).getTime();
const startOf = (y: number, m: number, d: number, hour = 0) => zonedDateTime(y, m, d, hour, TZ);

function expectDay(range: ReturnType<typeof parseEventTimeRange>, year: number, month: number, day: number) {
  assert(range, "应该能解析出日期");
  assert.equal(range.start.getTime(), startOf(year, month, day).getTime(), `起点应为 ${year}-${month}-${day} 00:00`);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  assert.equal(
    range.end.getTime(),
    startOf(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate()).getTime(),
    "终点应为次日 00:00",
  );
}

// ── 相对日期 ────────────────────────────────────────────────
expectDay(parseEventTimeRange("你还记得前天我做了什么吗", now, TZ), 2026, 10, 29);
expectDay(parseEventTimeRange("昨天", now, TZ), 2026, 10, 30);
expectDay(parseEventTimeRange("大前天呢", now, TZ), 2026, 10, 28);
expectDay(parseEventTimeRange("今天", now, TZ), 2026, 10, 31);
expectDay(parseEventTimeRange("3 天前", now, TZ), 2026, 10, 28);

// ── 时段收窄：下午 = 12:00–18:00 ─────────────────────────────
const yesterdayAfternoon = parseEventTimeRange("昨天下午在干嘛", now, TZ);
assert(yesterdayAfternoon);
assert.equal(yesterdayAfternoon.start.getTime(), startOf(2026, 10, 30, 12).getTime(), "下午从 12 点开始");
assert.equal(yesterdayAfternoon.end.getTime(), startOf(2026, 10, 30, 18).getTime(), "下午到 18 点结束");

// ── 绝对日期 ────────────────────────────────────────────────
expectDay(parseEventTimeRange("2026-10-25 那天", now, TZ), 2026, 10, 25);
expectDay(parseEventTimeRange("10月25日", now, TZ), 2026, 10, 25);

// ── 星期：以周一为一周起点 ──────────────────────────────────
expectDay(parseEventTimeRange("上周三", now, TZ), 2026, 10, 21);
expectDay(parseEventTimeRange("本周三", now, TZ), 2026, 10, 28);
expectDay(parseEventTimeRange("周三", now, TZ), 2026, 10, 28);
expectDay(parseEventTimeRange("本周日", now, TZ), 2026, 11, 1);

const lastWeek = parseEventTimeRange("上周", now, TZ);
assert(lastWeek, "整周也要能解析");
assert.equal(lastWeek.start.getTime(), startOf(2026, 10, 19).getTime(), "上周从周一 10-19 开始");
assert.equal(lastWeek.end.getTime(), startOf(2026, 10, 26).getTime(), "上周到本周一 10-26 结束");

// ── 认不出来就返回 null，不猜 ────────────────────────────────
assert.equal(parseEventTimeRange("你喜欢什么", now, TZ), null, "没有时间指向时不能瞎给区间");

// ── 忆泡选择：有日期 → 那天的时间线 ──────────────────────────
const events = [
  { id: "e1", title: "和小明在海边游泳", detail: "下午去游泳，玩了两个小时。", occurredAt: new Date("2026-10-29T14:00:00+08:00"), timeOfDay: "下午", place: "北海", participants: ["小明"], keywords: ["游泳", "银滩"] },
  { id: "e2", title: "和小红在美食街吃烧烤", detail: "晚上吃烧烤。", occurredAt: new Date("2026-10-29T19:30:00+08:00"), timeOfDay: "晚上", place: "南宁", participants: ["小红"], keywords: ["烧烤"] },
  { id: "e3", title: "在公司加班", detail: "写了一天的代码。", occurredAt: new Date("2026-10-30T21:00:00+08:00"), timeOfDay: "晚上", place: "公司", participants: [], keywords: ["加班"] },
];

const dayResult = selectEventsForPrompt("前天我做了什么", events, { now, timeZone: TZ });
assert.equal(dayResult.items.length, 2, "只返回前天的两条");
assert.deepEqual(dayResult.items.map((item) => item.id), ["e1", "e2"], "按发生时间正序，像一条时间线");
assert(dayResult.range, "要回传命中的区间，便于日志排查");

const emptyDay = selectEventsForPrompt("上周三我做了什么", events, { now, timeZone: TZ });
assert.equal(emptyDay.items.length, 0, "那天没有记录就什么都不给，不能拿别的日子凑");
assert(emptyDay.range, "区间仍然要回传，调用方才能说「那天没有记录」");

// ── 忆泡选择：没有日期 → 关键词 ──────────────────────────────
const keywordResult = selectEventsForPrompt("你还记得那次吃烧烤吗", events, { now, timeZone: TZ });
assert.deepEqual(keywordResult.items.map((item) => item.id), ["e2"], "关键词命中烧烤那条");
assert.equal(keywordResult.range, null, "没有日期时不该给出区间");

const noMatch = selectEventsForPrompt("今天天气怎么样", events, { now, timeZone: TZ });
assert.equal(noMatch.items.length, 0, "对不上的内容不能硬塞进上下文");

// ── 参与者过滤 / 取首聚合（P2）──────────────────────────────
const people = [
  { id: "p1", title: "和小明在银滩游泳", detail: "下午去的", occurredAt: new Date("2026-10-20T06:00:00Z"), participants: ["小明", "小鲸鱼i"], keywords: ["游泳"] },
  { id: "p2", title: "和小明吃饭", detail: "晚上", occurredAt: new Date("2026-10-25T10:00:00Z"), participants: ["小明"], keywords: ["吃饭"] },
  { id: "p3", title: "和小月跑步", detail: "早上", occurredAt: new Date("2026-10-22T00:00:00Z"), participants: ["小月"], keywords: ["跑步"] },
];
const byPerson = selectEventsForPrompt("我和小明都经历过什么", people, { now, timeZone: TZ });
assert.equal(byPerson.mode, "participant", "「和某人」问的是关于这个人的事，不该退化成关键词");
assert.deepEqual(byPerson.items.map((item) => item.id), ["p2", "p1"], "只留小明的事，按时间倒序");
assert(!byPerson.items.some((item) => item.id === "p3"), "小月的事不能混进来");

const firstMeet = selectEventsForPrompt("第一次见到小明是什么时候", people, { now, timeZone: TZ });
assert.equal(firstMeet.mode, "first", "「第一次」要走取首，而不是按相关度排");
assert.equal(firstMeet.items[0]?.id, "p1", "最早的那次排第一");

const unrelated = selectEventsForPrompt("你还记得烧烤吗", people, { now, timeZone: TZ });
assert.equal(unrelated.mode, "keyword", "没有明确指向某个人时不能按人过滤");

// ── 按账号找（QQ 号比昵称准）─────────────────────────────────
const withRefs = [
  { id: "r1", title: "和小明在银滩游泳", detail: "下午", occurredAt: new Date("2026-10-20T06:00:00Z"), participants: ["小明"], keywords: ["游泳"], participantRefs: [{ kind: "external", platform: "qq-onebot", externalId: "10000006" }] },
  { id: "r2", title: "群里聊代码", detail: "晚上", occurredAt: new Date("2026-10-21T10:00:00Z"), participants: ["群友"], keywords: ["代码"], participantRefs: [{ kind: "external", platform: "qq-onebot", externalId: "1111111111" }] },
];
const byAccount = selectEventsForPrompt("10000006 都聊过什么", withRefs, { now, timeZone: TZ });
assert.equal(byAccount.mode, "participant", "能认出 QQ 号就按账号过滤，比昵称准");
assert.deepEqual(byAccount.items.map((item) => item.id), ["r1"], "只留这个账号参与的事");
assert.equal(parseEventParticipantIdQuery("10000006 都聊过什么"), "10000006");
assert.equal(parseEventParticipantIdQuery("今天做了什么"), null, "没有号码时不能瞎猜账号");
// 号码对不上任何忆泡时，退回按名字找，不能因此返回空。
const fallback = selectEventsForPrompt("和小明都经历过什么", withRefs, { now, timeZone: TZ });
assert.equal(fallback.mode, "participant");
assert.deepEqual(fallback.items.map((item) => item.id), ["r1"], "名字兜底仍然可用");

// ── 预算：装不下整条跳过，但第一条永远放行 ────────────────────
const longEvent = { ...events[0]!, id: "long", detail: "写".repeat(400), occurredAt: new Date("2026-11-01T10:00:00+08:00") };
const budgeted = selectEventsForPrompt("11月1日", [longEvent], { now, timeZone: TZ, tokenBudget: 10 });
assert.equal(budgeted.items.length, 1, "第一条即使超预算也要放行，否则等于她什么都不记得");

// ── 幂等键：同一天同一件事只写一次 ───────────────────────────
const keyA = makeEventDedupeKey(new Date("2026-10-29T14:00:00+08:00"), "和小明在海边游泳");
const keyB = makeEventDedupeKey(new Date("2026-10-29T09:00:00+08:00"), "和小明在海边游泳");
assert.equal(keyA, keyB, "同一天、同一标题（哪怕时间不同）应得到同一个键");
const keyC = makeEventDedupeKey(new Date("2026-10-30T14:00:00+08:00"), "和小明在海边游泳");
assert.notEqual(keyA, keyC, "不同天的事件不能互相顶掉");
assert.equal(at("2026-10-29T00:00:00+08:00"), startOf(2026, 10, 29).getTime(), "时区换算自检");

// ── 按天整理的窗口：昨天整天 ────────────────────────────────
const daily = resolveDailyEventWindow(now, TZ);
assert.equal(daily.dayKey, "2026-10-30", "按天任务处理的是昨天");
assert.equal(daily.start.getTime(), startOf(2026, 10, 30).getTime(), "从昨天 00:00 开始");
assert.equal(daily.end.getTime(), startOf(2026, 10, 31).getTime(), "到今早 00:00 结束");

// ── 日期键与「天」窗口：DRAFT/FINAL 靠它分组 ────────────────
assert.equal(localDayKey(now, TZ), "2026-10-31", "当地日期键按角色时区算");
assert.equal(localDayKey(new Date("2026-10-31T16:30:00Z"), TZ), "2026-11-01", "跨零点要归到第二天，不能按 UTC 日期");
const dayWindow = resolveDayWindow("2026-10-30", TZ);
assert.equal(dayWindow.start.getTime(), startOf(2026, 10, 30).getTime());
assert.equal(dayWindow.end.getTime(), startOf(2026, 10, 31).getTime());
const dayHour = localDayHour(now, TZ);
assert.deepEqual(dayHour, { dayKey: "2026-10-31", hour: 14 }, "每小时增量靠 dayKey + 小时做幂等键");

// ── 原文兜底：忆泡还没产出的那一段 ──────────────────────────
const rawLines = [
  { id: "m1", role: "USER", content: "前天下午我们去银滩游泳了", occurredAt: new Date("2026-10-29T14:00:00+08:00") },
  { id: "m2", role: "ASSISTANT", content: "好啊，我带泳圈", occurredAt: new Date("2026-10-29T14:02:00+08:00") },
  { id: "m3", role: "USER", content: "今天在公司加班", occurredAt: new Date("2026-10-31T20:00:00+08:00") },
];
const rawSelected = selectRawMessagesForPrompt("前天我们干什么了", rawLines, { now, timeZone: TZ });
assert.equal(rawSelected.items.length, 2, "只取问句指向的那一天");
assert.equal(rawSelected.items[0]?.id, "m1", "原文按时间正序，读起来像时间线");
const rawExcluded = selectRawMessagesForPrompt("前天我们干什么了", rawLines, {
  now, timeZone: TZ, excludeIds: new Set(["m1"]),
});
assert(!rawExcluded.items.some((item) => item.id === "m1"), "已经进过对话窗口的消息不能重复塞");
assert.equal(
  selectRawMessagesForPrompt("你喜欢什么", rawLines, { now, timeZone: TZ }).items.length,
  0,
  "问句没有时间指向时不该额外查原文 —— 那是最近窗口的活",
);

// ── 单条原文截断：一条长粘贴不能把那天挤没 ──────────────────
// 不截断时只有两种结局：第一条永远放行（整条进提示词），或者装不下被整条跳过。
const longPaste = "前".repeat(RAW_MESSAGE_MAX_CHARS) + "后".repeat(400) + "关键词在尾巴上";
const clipped = selectRawMessagesForPrompt("前天翻车了吗", [
  { id: "m-long", role: "USER", content: longPaste, occurredAt: new Date("2026-10-29T15:00:00+08:00") },
], { now, timeZone: TZ });
assert.equal(clipped.items.length, 1, "只有这一条时也要给出来");
const clippedItem = clipped.items[0]!;
assert.equal(clippedItem.truncated, true, "超长的那条要标成截断");
assert(clippedItem.content.startsWith("前".repeat(RAW_MESSAGE_MAX_CHARS)), "保留的是开头，不是结尾");
assert.match(clippedItem.content, /后面还有 \d+ 字未展开/, "省略要说明还有多少，模型才不会以为话说完了");
assert(
  clippedItem.content.length < longPaste.length,
  "截断后的长度必须真的变短，否则预算照旧被吃光",
);
// token 反映的是**进提示词的那份**，不是原文 —— 否则预算判断会失真。
assert.equal(clippedItem.tokens, estimateTokens(clippedItem.content));
assert(clipped.usedTokens < RAW_MESSAGE_TOKEN_BUDGET_DEFAULT, "单条截断后不该一个预算就被吃光");

const shortLine = selectRawMessagesForPrompt("前天我们干什么了", rawLines, { now, timeZone: TZ });
assert.equal(shortLine.items[0]?.truncated, false, "没超长的原文原样给出，不加省略号");
assert.equal(shortLine.items[0]?.content, "前天下午我们去银滩游泳了");

// ── 时间线：忆泡要能按「还在记 / 已收口」区分 ────────────────
const timeline = toMemoryTimelineDtos({
  messages: [],
  memoryItems: [],
  snapshots: [],
  events: [
    {
      id: "e-draft",
      occurredAt: new Date("2026-10-29T06:00:00Z"),
      timeOfDay: "下午",
      place: "北海",
      participants: ["小明"],
      title: "和小明在海边游泳",
      detail: "去了银滩",
      state: "DRAFT" as const,
      memoryScope: { scopeType: "CHARACTER_GLOBAL" },
    },
    {
      id: "e-final",
      occurredAt: new Date("2026-10-28T06:00:00Z"),
      timeOfDay: null,
      place: null,
      participants: [],
      title: "在家写代码",
      detail: "写了一整天",
      state: "FINAL" as const,
      memoryScope: { scopeType: "USER_PRIVATE" },
    },
  ],
}, TZ);
assert.equal(timeline[0]?.type, "memoryEvent", "忆泡在时间线上是独立类型");
assert.equal(timeline[0]?.tag, "还在记", "DRAFT 要标成「还在记」，用户才知道之后还会变");
assert.equal(timeline[0]?.channel, "长期记忆", "角色全局范围的忆泡归到长期记忆");
assert.equal(timeline[1]?.tag, "已收口");
assert.equal(timeline[1]?.channel, "私人记忆", "私人范围的忆泡要标成私人记忆");

// ── 近义重复：同一件事换个说法也要能被挡住 ────────────────
assert(
  longestCommonSubstringLength("为新建QQ群1127611457发布群公告", "为新群起草并发布群公告") >= 5,
  "「发布群公告」这段公共子串要能识别出来。",
);
assert(
  longestCommonSubstringLength("在群10000004分析人类聊天与鱼的聊天区别", "在群里分析人类聊天与鱼聊天的区别") >= 6,
  "重跑时模型常见的换词写法要被挡住。",
);
assert(
  longestCommonSubstringLength("主人问她会不会搞黄色被拒", "今天下午去游泳") < 4,
  "不相干的事件不能被误判成重复。",
);
// 已知边界：只有人名重合（3 字）的短标题，要靠参与人交集才能判重。
assert(
  longestCommonSubstringLength("群友叫她小肥鱼，她坚持叫小鲸鱼i", "被叫「小肥鱼」后纠正称呼") < 6,
  "短标题只按字数挡不住 —— 所以还要看参与人。",
);
assert(
  isNearDuplicateEvent(
    { title: "群友叫她小肥鱼，她坚持叫小鲸鱼i", participants: ["群友", "小鲸鱼i"] },
    { title: "被叫「小肥鱼」后纠正称呼", participants: ["群友", "小鲸鱼i"] },
  ),
  "3 字重合 + 共同参与人 → 判为同一件事。",
);
assert(
  !isNearDuplicateEvent(
    { title: "群友叫她小肥鱼，她坚持叫小鲸鱼i", participants: ["群友"] },
    { title: "被叫「小肥鱼」后纠正称呼", participants: ["小明"] },
  ),
  "只有 3 字重合、参与人不同 → 不能判重。",
);
assert(
  !isNearDuplicateEvent(
    { title: "主人问她会不会搞黄色被拒", participants: ["主人"] },
    { title: "主人问她要不要一起吃饭", participants: ["主人"] },
  ),
  "「主人」是角色词，不算交集 —— 同主语的不同事件不能被吞掉。",
);

console.log("忆泡测试通过：相对/绝对日期、时段收窄、周起点、空区间、关键词回退、预算保底、幂等键、按天窗口、日期键与小时键、原文兜底与单条截断、时间线状态、近义去重、参与者过滤与取首。");
