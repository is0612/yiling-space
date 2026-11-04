import assert from "node:assert/strict";
import {
  localDayHour, localDayKey, parseEventTimeRange, resolveDailyEventWindow, resolveDayWindow, zonedDateTime,
} from "../server/utils/memory-event-time";
import {
  RAW_MESSAGE_MAX_CHARS, RAW_MESSAGE_TOKEN_BUDGET_DEFAULT, selectRawMessagesForMemoryAssistant, selectRawMessagesForPrompt,
} from "../server/utils/message-retrieval";
import { estimateTokens } from "../server/utils/memory-retrieval";
import { toMemoryTimelineDtos } from "../server/utils/memory-timeline-dto";
import { parseEventParticipantIdQuery, parseEventParticipantQuery, resolveEventRecentDays, selectEventsForPrompt, selectRecentEvents } from "../server/utils/memory-event-retrieval";
import { isNearDuplicateEvent, longestCommonSubstringLength, makeEventDedupeKey } from "../server/utils/memory-ai";
import {
  deriveParticipantRefs, resolveEventParticipants, type MemoryEvidenceMessage,
} from "../server/utils/memory-change-apply";
import { applyCurrentParticipantNames, readExternalParticipantRefs } from "../server/utils/participant-names";

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

// ── 年 / 月范围：整月、整年使用角色时区的自然边界 ──────────────
const lastMonth = parseEventTimeRange("上个月我们聊了什么", now, TZ);
assert(lastMonth);
assert.equal(lastMonth.start.getTime(), startOf(2026, 9, 1).getTime());
assert.equal(lastMonth.end.getTime(), startOf(2026, 10, 1).getTime());

const twoMonthsAgo = parseEventTimeRange("2个月前的事", now, TZ);
assert(twoMonthsAgo);
assert.equal(twoMonthsAgo.start.getTime(), startOf(2026, 8, 1).getTime());
assert.equal(twoMonthsAgo.end.getTime(), startOf(2026, 9, 1).getTime());

const lastYear = parseEventTimeRange("去年发生的事", now, TZ);
assert(lastYear);
assert.equal(lastYear.start.getTime(), startOf(2025, 1, 1).getTime());
assert.equal(lastYear.end.getTime(), startOf(2026, 1, 1).getTime());

const lastYearMonth = parseEventTimeRange("去年10月我们聊了什么", now, TZ);
assert(lastYearMonth);
assert.equal(lastYearMonth.start.getTime(), startOf(2025, 10, 1).getTime());
assert.equal(lastYearMonth.end.getTime(), startOf(2025, 11, 1).getTime());

const absoluteYearMonth = parseEventTimeRange("2025年11月的约定", now, TZ);
assert(absoluteYearMonth);
assert.equal(absoluteYearMonth.start.getTime(), startOf(2025, 11, 1).getTime());
assert.equal(absoluteYearMonth.end.getTime(), startOf(2025, 12, 1).getTime());

const absoluteYear = parseEventTimeRange("2024年我们认识多久了", now, TZ);
assert(absoluteYear);
assert.equal(absoluteYear.start.getTime(), startOf(2024, 1, 1).getTime());
assert.equal(absoluteYear.end.getTime(), startOf(2025, 1, 1).getTime());

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

assert.equal(parseEventParticipantQuery("第一次见到小明是什么时候"), "小明",
  "人物提问里的时间尾缀不能被吞进参与者名称。");
const firstMeet = selectEventsForPrompt("第一次见到小明是什么时候", people, { now, timeZone: TZ });
assert.equal(firstMeet.mode, "first", "「第一次」要走取首，而不是按相关度排");
assert.equal(firstMeet.items[0]?.id, "p1", "最早的那次排第一");

const foodHistory = [
  { id: "food-first", title: "第一次在海边吃烧烤", detail: "和小明一起吃烧烤。", occurredAt: new Date("2026-10-20T10:00:00Z"), participants: ["小明"], keywords: ["烧烤"] },
  { id: "food-last", title: "后来又去吃烧烤", detail: "这次在市区吃烧烤。", occurredAt: new Date("2026-10-30T12:00:00Z"), participants: ["小明"], keywords: ["烧烤"] },
];
const latestFood = selectEventsForPrompt("最近一次吃烧烤是什么时候", foodHistory, { now, timeZone: TZ });
assert.equal(latestFood.mode, "latest");
assert.deepEqual(latestFood.items.map((item) => item.id), ["food-last"],
  "「最近一次」必须优先时间最新，而不是只按关键词相关度。");
const firstFood = selectEventsForPrompt("第一次吃烧烤是什么时候", foodHistory, { now, timeZone: TZ });
assert.equal(firstFood.mode, "first");
assert.deepEqual(firstFood.items.map((item) => item.id), ["food-first"],
  "不带具体人物的「第一次」也要按最早事件排序。");

const lastYearTopic = [
  { id: "year-old", title: "去年年初聊过太空电影", detail: "讨论太空电影。", occurredAt: new Date("2025-02-01T10:00:00Z"), participants: [], keywords: ["太空电影"] },
  { id: "year-new", title: "去年年底又聊太空电影", detail: "继续讨论太空电影。", occurredAt: new Date("2025-12-15T10:00:00Z"), participants: [], keywords: ["太空电影"] },
  { id: "year-other", title: "去年去公园散步", detail: "和朋友散步。", occurredAt: new Date("2025-06-01T10:00:00Z"), participants: [], keywords: ["散步"] },
];
const lastYearRelevant = selectEventsForPrompt("去年我们聊过太空电影", lastYearTopic, {
  now, timeZone: TZ, limit: 1,
});
assert.deepEqual(lastYearRelevant.items.map((item) => item.id), ["year-new"],
  "宽时间范围应先选主题匹配项，并优先给出最近的相关记录，不能固定取年初。");

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

const deepSearchRawLines = [
  { id: "old-film", role: "USER", content: "我们当时聊了太空电影，提到星际穿越。", occurredAt: new Date("2025-04-12T10:00:00Z") },
  { id: "old-other", role: "USER", content: "去年一起去公园散步。", occurredAt: new Date("2025-08-12T10:00:00Z") },
  { id: "new-film", role: "USER", content: "今天也聊了太空电影。", occurredAt: new Date("2026-10-31T10:00:00Z") },
];
const deepSearchRaw = selectRawMessagesForMemoryAssistant("去年太空电影", deepSearchRawLines, {
  now, timeZone: TZ,
});
assert.deepEqual(deepSearchRaw.map((item) => item.id), ["old-film"],
  "记忆助手原文检索必须同时遵守明确年份与主题词，不能混入今年记录或无关聊天。");

const firstRawHistory = [
  { id: "raw-first", role: "USER", content: "第一次和小明去海边玩。", occurredAt: new Date("2025-01-10T10:00:00Z") },
  { id: "raw-latest", role: "USER", content: "后来又和小明去海边玩。", occurredAt: new Date("2025-10-10T10:00:00Z") },
];
const firstRawEvidence = selectRawMessagesForMemoryAssistant("第一次和小明去海边玩", firstRawHistory, {
  now, timeZone: TZ, limit: 1,
});
assert.equal(firstRawEvidence[0]?.id, "raw-first",
  "「第一次」检索原文时，相关度相同时必须优先最早消息。");
const latestRawEvidence = selectRawMessagesForMemoryAssistant("最近一次和小明去海边玩", firstRawHistory, {
  now, timeZone: TZ, limit: 1,
});
assert.equal(latestRawEvidence[0]?.id, "raw-latest",
  "「最近一次」检索原文时，相关度相同时必须优先最新消息。");
const semanticFallbackRawHistory = [
  { id: "semantic-old", role: "USER", content: "那阵子我们一起玩了好几款游戏。", occurredAt: new Date("2025-06-10T10:00:00Z") },
  { id: "semantic-recent", role: "USER", content: "后来我们又聊了新的旅行计划。", occurredAt: new Date("2026-09-10T10:00:00Z") },
];
const semanticFallbackRaw = selectRawMessagesForMemoryAssistant("回忆一下我们那个夏天", semanticFallbackRawHistory, {
  now, timeZone: TZ,
});
assert.deepEqual(semanticFallbackRaw.map((item) => item.id), ["semantic-old", "semantic-recent"],
  "没有直接关键词命中时，原文选择器应保留有限的近期候选，供语义检索器识别近义表达。");


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

// ── 近期忆泡：不看问句，按时间取 ─────────────────────────
// 和 selectEventsForPrompt 的分工：那个要命中，这个只要「够近」。
const recentPool = [
  { id: "e-today", title: "今天下午的", detail: "刚刚", occurredAt: new Date("2026-10-31T13:00:00+08:00"), participants: [], keywords: [] },
  { id: "e-yesterday", title: "昨天的", detail: "昨天", occurredAt: new Date("2026-10-30T20:00:00+08:00"), participants: [], keywords: [] },
  { id: "e-two-days", title: "前天的", detail: "前天", occurredAt: new Date("2026-10-29T10:00:00+08:00"), participants: [], keywords: [] },
  { id: "e-old", title: "上周的", detail: "早了", occurredAt: new Date("2026-10-24T20:00:00+08:00"), participants: [], keywords: [] },
];
assert.deepEqual(selectRecentEvents(recentPool, { now, days: 0 }).items, [], "关掉时一条都不带");
assert.deepEqual(
  selectRecentEvents(recentPool, { now, days: 2 }).items.map((event) => event.id),
  ["e-today", "e-yesterday"],
  "两天窗口内按时间取，最近的排前面",
);
assert.deepEqual(
  selectRecentEvents(recentPool, { now, days: 2, excludeIds: new Set(["e-today"]) }).items.map((event) => event.id),
  ["e-yesterday"],
  "这一轮已经按关键词挑中的，不能再出现一次",
);
assert.equal(selectRecentEvents(recentPool, { now, days: 2, limit: 1 }).items.length, 1, "条数上限要生效");
assert.equal(resolveEventRecentDays({ eventRecentDays: 3 }), 3, "按角色配置开几天");
assert.equal(resolveEventRecentDays({}), 0, "没配就是关");
assert.equal(resolveEventRecentDays({ eventRecentDays: 99 }), 14, "上限 14 天，别让一句配置把整段历史塞进提示词");

// ── 参与者清洗：泛称换成真名、她自己不算「相关人物」────────────
// 群聊里模型认不出人时会写「群友」，那条忆泡当场丢掉那个人：卡片上看不出是谁、
// 按人检索匹配不到、回答只能说「有个群友」。这里用确定性规则补回来。
const evidenceMsg = (over: Partial<MemoryEvidenceMessage> & { id: string }): MemoryEvidenceMessage => ({
  occurredAt: new Date("2026-10-31T14:00:00+08:00"),
  role: "USER",
  ...over,
});

// 线上真实那条「答题接龙」：participants = {小鲸鱼i, 群友}，小鲸鱼i 是角色自己。
assert.deepEqual(
  resolveEventParticipants(
    ["小鲸鱼i", "群友"],
    [evidenceMsg({ id: "a", role: "ASSISTANT" }), evidenceMsg({ id: "b", speaker: "阿深" })],
    "小鲸鱼i",
  ),
  ["阿深"],
  "她自己不该出现在参与者里，泛称要换成真实昵称",
);

// 证据里有两个人都说过话：不猜是谁，但泛称要留着 —— 删掉等于把「有别人参与」
// 改成「没有别人参与」，那是错的。
assert.deepEqual(
  resolveEventParticipants(
    ["群友"],
    [evidenceMsg({ id: "a", speaker: "阿深" }), evidenceMsg({ id: "b", speaker: "黛蓝" })],
    "小鲸鱼i",
  ),
  ["群友"],
  "两个候选时不猜，泛称保留（有别人参与这个信息不能丢）",
);

// 旧忆泡没有来源消息，只能做确定性清洗：剔掉她自己，泛称无从替换就留着。
assert.deepEqual(
  resolveEventParticipants(["小鲸鱼i", "群友"], [], "小鲸鱼i"),
  ["群友"],
  "没有证据时不猜名字，但泛称保留、她自己剔掉",
);

// 已经点名一个，泛称只能是剩下的那个。
assert.deepEqual(
  resolveEventParticipants(
    ["阿深", "群友"],
    [evidenceMsg({ id: "a", speaker: "阿深" }), evidenceMsg({ id: "b", speaker: "黛蓝" })],
    "小鲸鱼i",
  ),
  ["阿深", "黛蓝"],
  "已点名的保留，泛称补成证据里剩下的那一个",
);

// 模型漏写参与者，但证据里只有一个人跟她互动。
assert.deepEqual(
  resolveEventParticipants(
    [],
    [evidenceMsg({ id: "a", role: "ASSISTANT" }), evidenceMsg({ id: "b", speaker: "阿深" })],
    "小鲸鱼i",
  ),
  ["阿深"],
  "证据里只有一个人时，空参与者也要补上名字",
);

// 只有她自己在说话：不能凭空冒出一个人。
assert.deepEqual(
  resolveEventParticipants([], [evidenceMsg({ id: "a", role: "ASSISTANT" })], "小鲸鱼i"),
  [],
  "只有她的消息时不该编出在场的人",
);

// 主人用「主人」这个称呼，不被昵称覆盖，也照常按人补泛称。
assert.deepEqual(
  resolveEventParticipants(
    ["主人", "群友"],
    [evidenceMsg({ id: "a", isOwner: true, speaker: "老陈" }), evidenceMsg({ id: "b", speaker: "阿深" })],
    "小鲸鱼i",
  ),
  ["主人", "阿深"],
  "主人保留称谓，泛称补成主人之外那个人",
);

// 重复项和空白要被清掉。
assert.deepEqual(
  resolveEventParticipants(["阿深", " 阿深 ", "群友", ""], [evidenceMsg({ id: "a", speaker: "阿深" })], "小鲸鱼i"),
  ["阿深"],
  "同名去重、空串丢弃",
);

// 引用要带上当时的叫法：昵称会改，以后回溯「那时他叫什么」不用再回表。
assert.deepEqual(
  deriveParticipantRefs([
    evidenceMsg({ id: "a", role: "ASSISTANT" }),
    evidenceMsg({ id: "b", speaker: "阿深", authorOpenId: "10001", platform: "qq-onebot" }),
  ]),
  [
    { kind: "self" },
    { kind: "external", platform: "qq-onebot", externalId: "10001", displayName: "阿深" },
  ],
  "外部引用要记住当时的显示名",
);

// ── 改名：用账号锚点把旧名刷成当前名 ────────────────────────
// 群名片随时会改（实测 134 个账号里 17 个两天内就改过）。忆泡存的是当时的名字，
// 注入前必须换成现在的，否则她说出的名字对方不认识。
const refsOf = (name: string, uid: string) => [{
  kind: "external", platform: "qq-onebot", externalId: uid, displayName: name,
}];

assert.deepEqual(
  applyCurrentParticipantNames(["青", "小明"], refsOf("青", "100001"), new Map([["100001", "小刚"]])),
  ["小刚", "小明"],
  "改过名的参与者要换成当前叫法",
);

assert.deepEqual(
  applyCurrentParticipantNames(["青"], refsOf("青", "100001"), new Map()),
  ["青"],
  "查不到当前名字时保留旧名，不能变成空",
);

assert.deepEqual(
  applyCurrentParticipantNames(["小刚"], refsOf("青", "100001"), new Map([["100001", "小刚"]])),
  ["小刚"],
  "已经是新名字时不重复处理",
);

assert.deepEqual(
  applyCurrentParticipantNames(["小刚"], refsOf("小刚同学", "100002"), new Map([["100002", "小刚同学（新）"]])),
  ["小刚同学（新）"],
  "模型写的是简称时也要认得出是他",
);

assert.deepEqual(
  applyCurrentParticipantNames(["青"], null, new Map([["100001", "小刚"]])),
  ["青"],
  "老忆泡没有引用列，无从刷新，保持原样",
);

assert.deepEqual(
  applyCurrentParticipantNames(["青"], [{ kind: "external", externalId: "   " }], new Map()),
  ["青"],
  "结构不完整的引用直接忽略，不猜账号",
);

assert.equal(
  readExternalParticipantRefs([
    { kind: "self" },
    { kind: "owner" },
    { kind: "external", platform: "qq-onebot", externalId: "1", displayName: "甲" },
  ]).length,
  1,
  "只取 external 引用：self 和 owner 不是外部账号",
);

// ── 改名后的按人检索：名字是入口，账号才是身份 ────────────────
const renamed = [
  {
    id: "n1", title: "替青记下 BLG 八强赛的说法", detail: "八强赛的赛程",
    occurredAt: new Date("2026-11-02T10:00:00+08:00"), participants: ["青"], keywords: ["比赛"],
    participantRefs: [{ kind: "external", platform: "qq-onebot", externalId: "100001" }],
  },
];
assert.equal(
  selectEventsForPrompt("和鱼小刚都聊过什么", renamed, { now, timeZone: TZ }).mode,
  "keyword",
  "只比字符串时，改名后的新名字查不到旧忆泡（这正是要修的缺口）",
);
const byRenamedAccount = selectEventsForPrompt("和鱼小刚都聊过什么", renamed, {
  now, timeZone: TZ, participantIds: ["100001"],
});
assert.equal(byRenamedAccount.mode, "participant", "解析出账号后，新名字也能查到旧名记下的忆泡");
assert.deepEqual(byRenamedAccount.items.map((item) => item.id), ["n1"]);

const byOldName = selectEventsForPrompt("和青都聊过什么", renamed, {
  now, timeZone: TZ, participantIds: ["100001"],
});
assert.deepEqual(byOldName.items.map((item) => item.id), ["n1"], "名字与账号命中同一条时不能重复出现");

const unrelatedAccount = selectEventsForPrompt("和鱼小刚都聊过什么", renamed, {
  now, timeZone: TZ, participantIds: ["999999"],
});
assert.equal(unrelatedAccount.mode, "keyword", "账号对不上时不能硬凑成按人过滤");

console.log("忆泡测试通过：相对/绝对日期、时段收窄、周起点、空区间、关键词回退、预算保底、幂等键、按天窗口、日期键与小时键、原文兜底与单条截断、时间线状态、近义去重、参与者过滤与取首、近期忆泡、参与者清洗与反查名字、改名刷新、按账号检索。");
