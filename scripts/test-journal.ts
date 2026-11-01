import assert from "node:assert/strict";
import {
  DIARY_CONTENT_MIN,
  DIARY_PROMPT_VERSION,
  HANDBOOK_PROMPT_VERSION,
  HANDBOOK_QUOTE_MIN,
  diarySystemPrompt,
  diaryContentError,
  handbookSystemPrompt,
  isQuoteFromContent,
  renderHandbookContent,
  validateDiaryAiOutput,
  validateHandbookAiOutput,
  type JournalAiInput,
  type JournalEvidenceSourceTexts,
} from "../server/utils/journal-ai";
import { isJournalDayKey, journalCalendarContext, readJournalJobParams, retryOnVersionConflict } from "../server/utils/journal-service";
import { firstJournalLine } from "../server/utils/journal-dto";

/**
 * 日记 / 手账的纯逻辑：来源白名单、摘句校验、SKIP、日期键。
 *
 * 两份文本共用素材，但校验规则不同：日记是一篇叙事；手账是结构化记录，
 * 它的一句必须能在**给定的日记正文**里找到。
 */

const diaryContent = [
  "今天下午其实有点不开心。一开始我觉得自己的想法没有问题，所以主人提出不同意见的时候，我还有点不服气。",
  "后来重新看了一遍，才发现他的担心确实有道理。虽然中间有点小别扭，不过最后还是一起把问题解决了。",
].join("\n");

const validMessages = ["msg-1", "msg-2"];
const validEvents = ["event-1"];
const sourceTexts: JournalEvidenceSourceTexts = {
  messages: new Map([
    ["msg-1", "今天下午跟主人讨论项目，意见不太一样。晚上一起把问题改好了。坚持自己的想法没错，但也应该认真听听别人的意见。"],
    ["msg-2", "明天再看看改完的效果。"],
  ]),
  events: new Map([
    ["event-1", "分歧不等于否定。\n两个人在项目上意见不同，最后一起把问题解决了。"],
  ]),
};

function diaryBase(overrides: Record<string, unknown> = {}) {
  return {
    action: "CREATE",
    title: "有点小别扭的一天",
    content: diaryContent,
    sourceMessageIds: ["msg-1"],
    sourceEventIds: ["event-1"],
    ...overrides,
  };
}

function handbookBase(overrides: Record<string, unknown> = {}) {
  return {
    action: "CREATE",
    snippets: ["下午跟主人讨论项目，意见不太一样。", "晚上一起把问题改好了。"],
    thought: "坚持自己的想法没错，但也应该认真听听别人的意见。",
    quote: "我还有点不服气",
    inspirations: ["分歧不等于否定。"],
    followUps: ["明天再看看改完的效果。"],
    tags: ["项目", "自我反思"],
    sourceMessageIds: ["msg-1"],
    sourceEventIds: ["event-1"],
    evidence: [
      {
        text: "下午跟主人讨论项目，意见不太一样。",
        quote: "今天下午跟主人讨论项目，意见不太一样",
        sourceMessageIds: ["msg-1"],
        sourceEventIds: [],
      },
      {
        text: "晚上一起把问题改好了。",
        quote: "晚上一起把问题改好了",
        sourceMessageIds: ["msg-1"],
        sourceEventIds: [],
      },
      {
        text: "坚持自己的想法没错，但也应该认真听听别人的意见。",
        quote: "坚持自己的想法没错，但也应该认真听听别人的意见",
        sourceMessageIds: ["msg-1"],
        sourceEventIds: [],
      },
      {
        text: "分歧不等于否定。",
        quote: "分歧不等于否定",
        sourceMessageIds: [],
        sourceEventIds: ["event-1"],
      },
      {
        text: "明天再看看改完的效果。",
        quote: "明天再看看改完的效果",
        sourceMessageIds: ["msg-2"],
        sourceEventIds: [],
      },
    ],
    ...overrides,
  };
}

// 1. 日记：正常输出
{
  const entry = validateDiaryAiOutput(diaryBase(), validMessages, validEvents);
  assert.equal(entry.action, "CREATE");
  if (entry.action !== "CREATE") throw new Error("expected CREATE");
  assert.equal(entry.title, "有点小别扭的一天");
  assert.deepEqual(entry.sourceMessageIds, ["msg-1"]);
  assert.equal(entry.thought, undefined, "日记没有「想法」字段");
}

// 2. 日记：太短 / 编来源 / SKIP
{
  assert.throws(
    () => validateDiaryAiOutput(diaryBase({ content: "太短" }), validMessages, validEvents),
    /LLM_INVALID_CONTENT/,
  );
  assert.throws(
    () => validateDiaryAiOutput(diaryBase({ sourceMessageIds: ["fake"], sourceEventIds: [] }), validMessages, validEvents),
    /LLM_INVALID_SOURCES/,
  );
  const skip = validateDiaryAiOutput({ action: "SKIP", reason: "今天只有寒暄。" }, validMessages, validEvents);
  assert.equal(skip.action, "SKIP");
  assert.ok(DIARY_CONTENT_MIN > 0);
}

// 3. 手账：栏目拼成正文，想法/一句/标签独立保存
{
  const entry = validateHandbookAiOutput(handbookBase(), validMessages, validEvents, diaryContent, sourceTexts);
  assert.equal(entry.action, "CREATE");
  if (entry.action !== "CREATE") throw new Error("expected CREATE");
  assert.match(entry.content, /## 今日片段/);
  assert.match(entry.content, /## 灵感与发现/);
  assert.match(entry.content, /## 待续事项/);
  assert.equal(entry.thought, "坚持自己的想法没错，但也应该认真听听别人的意见。");
  assert.equal(entry.quote, "我还有点不服气");
  assert.deepEqual(entry.tags, ["项目", "自我反思"]);
  assert.ok(HANDBOOK_QUOTE_MIN > 0);
}

// 4. 手账：一句必须来自给定日记；不是原话就丢掉这一句，不连坐其它栏目
{
  const entry = validateHandbookAiOutput(handbookBase({ quote: "今天真是充实的一天。" }), validMessages, validEvents, diaryContent, sourceTexts);
  if (entry.action !== "CREATE") throw new Error("expected CREATE");
  assert.equal(entry.quote, undefined);
  assert.ok(entry.content.length > 0);
}

// 5. 手账：那天没有日记时，一句不能凭空存在
{
  const entry = validateHandbookAiOutput(handbookBase(), validMessages, validEvents, null, sourceTexts);
  if (entry.action !== "CREATE") throw new Error("expected CREATE");
  assert.equal(entry.quote, undefined);
}

// 6. 手账：一个栏目都没有 → 拒绝；没有来源 → 拒绝
{
  assert.throws(
    () => validateHandbookAiOutput({
      action: "CREATE",
      snippets: [],
      thought: "",
      quote: "",
      inspirations: [],
      followUps: [],
      tags: [],
      sourceMessageIds: ["msg-1"],
    }, validMessages, validEvents, diaryContent, sourceTexts),
    /LLM_INVALID_CONTENT/,
  );
  assert.throws(
    () => validateHandbookAiOutput(handbookBase({ sourceMessageIds: [], sourceEventIds: [], evidence: [] }), validMessages, validEvents, diaryContent, sourceTexts),
    /LLM_INVALID_SOURCES/,
  );
}

// 6.1 手账：栏目必须挂真实 evidence；通用格言/假 ID/来源不匹配不能通过
{
  // 没有 evidence 的栏目被丢掉；有 diary quote 和 tags 时仍可留下非栏目内容。
  const noEvidence = validateHandbookAiOutput(handbookBase({ evidence: [] }), validMessages, validEvents, diaryContent, sourceTexts);
  if (noEvidence.action !== "CREATE") throw new Error("expected CREATE");
  assert.equal(noEvidence.content, "", "没有来源证据的片段/想法不能保存");
  assert.equal(noEvidence.thought, undefined, "通用格言不能凭全局 source ID 通过");

  // 假来源 ID：即使 evidence 指向它，也不能作为有效依据。
  assert.throws(
    () => validateHandbookAiOutput(handbookBase({
      snippets: ["人生就是要努力。"],
      thought: undefined,
      inspirations: [],
      followUps: [],
      tags: [],
      quote: "",
      evidence: [{ text: "人生就是要努力。", quote: "人生就是要努力", sourceMessageIds: ["fake"], sourceEventIds: [] }],
    }), validMessages, validEvents, diaryContent, sourceTexts),
    /来源证据|LLM_INVALID_SOURCES|LLM_INVALID_CONTENT/,
  );

  // 来源 ID 真实但 quote 不在那条来源里：证据不成立，栏目不能保存。
  assert.throws(
    () => validateHandbookAiOutput(handbookBase({
      snippets: ["人生就是要努力。"],
      thought: undefined,
      inspirations: [],
      followUps: [],
      tags: [],
      quote: "",
      evidence: [{ text: "人生就是要努力。", quote: "晚上一起把问题改好了", sourceMessageIds: ["msg-1"], sourceEventIds: [] }],
    }), validMessages, validEvents, diaryContent, sourceTexts),
    /来源证据/,
  );

  // 真实事件来源可以支撑栏目；事件 ID 也会进入最终来源列表。
  const eventEntry = validateHandbookAiOutput(handbookBase({
    snippets: ["分歧不等于否定。"],
    thought: undefined,
    inspirations: [],
    followUps: [],
    tags: [],
    quote: "",
    sourceMessageIds: [],
    sourceEventIds: [],
    evidence: [{ text: "分歧不等于否定。", quote: "分歧不等于否定", sourceMessageIds: [], sourceEventIds: ["event-1"] }],
  }), validMessages, validEvents, diaryContent, sourceTexts);
  if (eventEntry.action !== "CREATE") throw new Error("expected CREATE");
  assert.match(eventEntry.content, /分歧不等于否定/);
  assert.deepEqual(eventEntry.sourceEventIds, ["event-1"]);
}

// 6.2 日记：短但完整的正文可以保存；空/空白/纯符号/重复占位拒绝
{
  const short = "今天有点累，想早点睡。";
  assert.equal(diaryContentError(short), null, "短而完整的日记应通过");
  assert.equal(validateDiaryAiOutput(diaryBase({ content: short }), validMessages, validEvents).action, "CREATE");
  assert.notEqual(diaryContentError(""), null);
  assert.notEqual(diaryContentError("   \n  "), null);
  assert.notEqual(diaryContentError("。。。！？"), null);
  assert.notEqual(diaryContentError("好好好好好好好好"), null);
  assert.throws(
    () => validateDiaryAiOutput(diaryBase({ content: "啊".repeat(2001) }), validMessages, validEvents),
    /LLM_INVALID_CONTENT/,
  );
  assert.throws(
    () => validateDiaryAiOutput(diaryBase({ content: "今天".repeat(1001) + "。" }), validMessages, validEvents),
    /太长/,
    "最大长度保护仍要保留",
  );
}


{
  const skip = validateHandbookAiOutput({ action: "SKIP", reason: "没什么可留的。" }, validMessages, validEvents, diaryContent, sourceTexts);
  assert.equal(skip.action, "SKIP");
}

// 8. 空白归一化与子串判定
{
  assert.equal(isQuoteFromContent(diaryContent, "我还有点不服气"), true);
  assert.equal(isQuoteFromContent(diaryContent, "有点不开心。  一开始"), true, "空白差异不算改字");
  assert.equal(isQuoteFromContent(diaryContent, "他今天很开心"), false);
}

// 9. 手账正文渲染：空栏目不出现小标题
{
  assert.equal(renderHandbookContent({ snippets: ["片段"], inspirations: [], followUps: [] }), "## 今日片段\n- 片段");
}

// 10. 日期键 / 列表首句
{
  assert.equal(isJournalDayKey("2026-10-31"), true);
  assert.equal(isJournalDayKey("2026-13-01"), false);
  assert.equal(isJournalDayKey("2026-02-30"), false);
  assert.equal(isJournalDayKey("2026-1-1"), false);
  assert.equal(firstJournalLine("今天下午其实有点不开心。后面还有。"), "今天下午其实有点不开心");
  assert.equal(firstJournalLine(""), "");
}

// 10.1 手账任务参数：日期与目标不能从最后一个冒号后的字段猜
{
  const scope = "11111111-1111-4111-8111-111111111111";
  const legacy = readJournalJobParams({ idempotencyKey: `journal:${scope}:2026-10-31` });
  assert.equal(legacy.ok, true);
  if (!legacy.ok) throw new Error("legacy key should parse");
  assert.equal(legacy.dayKey, "2026-10-31");
  assert.equal(legacy.target, "BOTH");

  const diary = readJournalJobParams({ idempotencyKey: `journal:${scope}:2026-10-31:DIARY` });
  assert.equal(diary.ok, true);
  if (!diary.ok) throw new Error("diary key should parse");
  assert.equal(diary.target, "DIARY");

  const handbook = readJournalJobParams({ idempotencyKey: `journal:${scope}:2026-10-31:HANDBOOK` });
  assert.equal(handbook.ok, true);
  if (!handbook.ok) throw new Error("handbook key should parse");
  assert.equal(handbook.target, "HANDBOOK");

  const both = readJournalJobParams({ idempotencyKey: `journal:${scope}:2026-10-31:DIARY+HANDBOOK` });
  assert.equal(both.ok, true);
  if (!both.ok) throw new Error("both key should parse");
  assert.equal(both.target, "BOTH");

  const retryBoth = readJournalJobParams({ idempotencyKey: `journal:${scope}:2026-10-31:retry-1760000000000` });
  assert.equal(retryBoth.ok, true);
  if (!retryBoth.ok) throw new Error("retry key should parse");
  assert.equal(retryBoth.dayKey, "2026-10-31");
  assert.equal(retryBoth.target, "BOTH");

  const retryHandbook = readJournalJobParams({ idempotencyKey: `journal:${scope}:2026-10-31:HANDBOOK:retry-1760000000000` });
  assert.equal(retryHandbook.ok, true);
  if (!retryHandbook.ok) throw new Error("retry handbook key should parse");
  assert.equal(retryHandbook.dayKey, "2026-10-31");
  assert.equal(retryHandbook.target, "HANDBOOK");

  const explicit = readJournalJobParams({
    idempotencyKey: "not-a-journal-key",
    journalDayKey: "2026-11-01",
    journalTarget: "HANDBOOK",
  });
  assert.equal(explicit.ok, true);
  if (!explicit.ok) throw new Error("explicit params should win");
  assert.equal(explicit.dayKey, "2026-11-01");
  assert.equal(explicit.target, "HANDBOOK");
  assert.equal(explicit.source, "explicit");

  assert.equal(readJournalJobParams({ idempotencyKey: "journal:" + scope + ":2026-10-31:RETRY" }).ok, false);
  assert.equal(readJournalJobParams({ idempotencyKey: "journal:" + scope + ":2026-13-01:HANDBOOK" }).ok, false);
  assert.equal(readJournalJobParams({ idempotencyKey: "journal:" + scope + ":2026-10-31:DIARY+OTHER" }).ok, false);
  assert.equal(readJournalJobParams({ idempotencyKey: "journal:" + scope + ":2026-10-31", journalDayKey: "2026-02-30" }).ok, false);
  assert.equal(readJournalJobParams({ idempotencyKey: "journal:" + scope + ":2026-10-31", journalTarget: "ALL" }).ok, false);
}

// 10.2 角色日历：今天/昨天按角色时区，不按浏览器；跨午夜与 DST 用日历加减。
{
  const shanghai = journalCalendarContext(new Date("2026-11-01T16:30:00.000Z"), "Asia/Shanghai");
  assert.equal(shanghai.timeZone, "Asia/Shanghai");
  assert.equal(shanghai.todayKey, "2026-11-02", "上海已过午夜，今天应是 11-02");
  assert.equal(shanghai.yesterdayKey, "2026-11-01");

  const utc = journalCalendarContext(new Date("2026-11-01T16:30:00.000Z"), "UTC");
  assert.equal(utc.todayKey, "2026-11-01");
  assert.equal(utc.yesterdayKey, "2026-10-31");

  // 纽约 2026-03-08 进入夏令时；昨天必须按本地日历减一天，不能固定减 24 小时。
  const dst = journalCalendarContext(new Date("2026-03-09T04:30:00.000Z"), "America/New_York");
  assert.equal(dst.todayKey, "2026-03-09");
  assert.equal(dst.yesterdayKey, "2026-03-08");

  const fallback = journalCalendarContext(new Date("2026-11-01T16:30:00.000Z"), "Not/AZone");
  assert.equal(fallback.timeZone, "Asia/Shanghai", "坏时区回落到角色默认时区");
}


{
  let calls = 0;
  const result = await retryOnVersionConflict(async () => {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error("version conflict"), { code: "P2002" });
    return "ok";
  });
  assert.equal(result, "ok");
  assert.equal(calls, 2, "P2002 应重试一次");

  let attempts = 0;
  await assert.rejects(
    retryOnVersionConflict(async () => {
      attempts += 1;
      throw Object.assign(new Error("still conflicting"), { code: "P2002" });
    }, 2),
    /still conflicting/,
  );
  assert.equal(attempts, 2, "重试次数有上限");

  await assert.rejects(
    retryOnVersionConflict(async () => {
      throw Object.assign(new Error("db down"), { code: "P1001" });
    }),
    /db down/,
  );
  /**
   * 提示词契约：版本号 + 群聊发言人规则。
   *
   * 版本号是给人看的「这次改了什么」，改动提示词必须一起升；发言人规则是 P1-3 的
   * 实际生效点 —— 字段传对了但提示词没要求，模型照样会把群友的经历写成她的。
   */
  assert.equal(DIARY_PROMPT_VERSION, "journal-diary-v3", "日记提示词版本变化要同步这里");
  assert.equal(HANDBOOK_PROMPT_VERSION, "journal-handbook-v3", "手账提示词版本变化要同步这里");

  const promptInput: JournalAiInput = {
    apiKey: "test-key",
    model: "test-model",
    dayKey: "2026-10-31",
    timezone: "Asia/Shanghai",
    characterName: "小鲸鱼i",
    basePrompt: "test persona",
    messages: [
      { id: "m1", role: "USER", occurredAt: "2026-10-31T10:00:00.000Z", content: "我昨天去旅行了。", speaker: "群友A" },
      { id: "m2", role: "ASSISTANT", occurredAt: "2026-10-31T10:01:00.000Z", content: "听起来不错。" },
    ],
    events: [],
    totalMessageCount: 2,
    omittedMessageCount: 0,
  };
  const diaryPrompt = diarySystemPrompt(promptInput);
  const handbookPrompt = handbookSystemPrompt(promptInput);
  for (const [label, prompt] of [["日记", diaryPrompt], ["手账", handbookPrompt]] as const) {
    assert(prompt.includes("speaker"), `${label}提示词要提到 speaker 字段，否则模型不知道按谁区分`);
    assert(prompt.includes("isOwner"), `${label}提示词要提到 isOwner，否则分不出主人`);
    assert(
      /别人|群友/.test(prompt),
      `${label}提示词要明确「别人经历的事不能写成自己做的」`,
    );
  }
  assert(handbookPrompt.includes("evidence"), "手账提示词必须要求逐条 evidence");

  const eventsOnlyInput: JournalAiInput = {
    ...promptInput,
    messages: [],
    events: [{ id: "ev-1", occurredAt: "2026-10-31T10:00:00.000Z", title: "去海边散步", detail: "傍晚一个人走了很久。" }],
    totalMessageCount: 0,
  };
  for (const [label, prompt] of [
    ["日记", diarySystemPrompt(eventsOnlyInput)],
    ["手账", handbookSystemPrompt(eventsOnlyInput)],
  ] as const) {
    assert(/只剩.*忆泡/.test(prompt), `${label}只有忆泡时要明确告知素材边界`);
    assert(/不要编造对话原文/.test(prompt), `${label}只有忆泡时不能伪造原文`);
  }
}

console.log("✅ test-journal 全部通过");
console.log("   日记：第一人称叙事校验 / 来源白名单 / SKIP");
console.log("   手账：栏目渲染 / 一句必须来自日记 / 空手账拒绝");
console.log("   日期键与列表首句：通过");
console.log("   提示词契约：版本号 + 群聊发言人规则");
