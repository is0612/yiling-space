import assert from "node:assert/strict";
import { selectPromptMemoryContext, PROMPT_EVENT_DETAIL_MAX_CHARS, type PromptEventCandidate } from "../server/utils/prompt-memory-selection";

const now = new Date("2026-11-21T10:00:00+08:00");
const day = (offset: number) => new Date(now.getTime() - offset * 86_400_000);

const eventCandidate = (id: string, occurredAt: Date, extra: Partial<PromptEventCandidate> = {}): PromptEventCandidate => ({
  id, title: `事件${id}`, detail: "细".repeat(PROMPT_EVENT_DETAIL_MAX_CHARS + 120), occurredAt,
  participants: ["旧名"], keywords: [], memoryScopeId: "global", ...extra,
});

const base = {
  query: "还记得那次海边的约定吗",
  now,
  timeZone: "Asia/Shanghai",
  memoryCandidates: [
    { id: "m-old", category: "FACT", content: "海边的约定是明年春天再去。", confidence: null, validFrom: day(90), createdAt: day(90), memoryScopeId: "global" },
    { id: "m-private", category: "GOAL", content: "私人约定：下次带她去海边。", confidence: null, validFrom: null, createdAt: day(30), memoryScopeId: "private" },
    { id: "m-unrelated", category: "FACT", content: "她不喜欢香菜。", confidence: null, validFrom: null, createdAt: day(1), memoryScopeId: "global" },
  ],
  snapshotCandidates: [
    { id: "s-1", summary: "海边的约定与后续计划。", periodStart: day(10), periodEnd: day(3), version: 2, createdAt: day(3), memoryScopeId: "global" },
    { id: "s-2", summary: "日常琐事。", periodStart: day(2), periodEnd: day(1), version: 1, createdAt: day(1), memoryScopeId: "global" },
  ],
  eventCandidates: [
    eventCandidate("e-today", day(0)),
    eventCandidate("e-yesterday", day(1), { timeOfDay: "下午", place: "海边", title: "海边的约定", detail: `海边约定${"细".repeat(PROMPT_EVENT_DETAIL_MAX_CHARS)}` }),
    eventCandidate("e-week", day(7)),
  ],
  participantIds: [] as string[],
  limits: { memoryItems: 20, memoryTokens: 1800, snapshots: 4, snapshotTokens: 2500, events: 8, eventTokens: 800, recentEventDays: 0 },
  scopeOf: (scopeId: string) => (scopeId === "global" ? "character" as const : "private" as const),
};

const result = await selectPromptMemoryContext({
  ...base,
  loadParticipantNames: async events => events.map(() => ["新名"]),
});

// 只能放进提示词的东西：相关但不相关的不要硬塞。
assert.deepEqual(result.memories.map(item => item.id).sort(), ["m-old", "m-private"], "无关记忆不该进这一轮");
assert.equal(result.memories.find(item => item.id === "m-private")?.scope, "private", "私人范围的标签要保留");
assert.equal(result.memories.find(item => item.id === "m-old")?.occurredAt, day(90).toISOString(), "occurredAt 用 validFrom");
assert.equal(result.memories.find(item => item.id === "m-private")?.occurredAt, day(30).toISOString(), "没有 validFrom 时退回入库时间");

assert.equal(result.snapshots[0]?.id, "s-1", "相关快照排前面");
assert.equal(result.snapshots[0]?.summary.length, "海边的约定与后续计划。".length, "快照正文原样保留");

// 忆泡：正文截断、名字刷新、顺序按时间。
const selected = result.events;
assert(selected.length >= 1, "关键词命中的忆泡要带上");
assert.equal(selected[0]?.detail.length, PROMPT_EVENT_DETAIL_MAX_CHARS, "忆泡正文按统一上限截断");
assert.deepEqual(selected[0]?.participants, ["新名"], "参与者名字用注入的当前叫法覆盖旧名");
assert.equal(selected[0]?.scope, "character", "全局范围的忆泡标 character");
assert.equal(result.eventSelection.range, null, "没有日期指向时不编造区间");

// 诊断：条数与预算要和结果一致，否则页面会说「放了 3 条」实际只放了 2 条。
assert.equal(result.selection.memory.count, result.memories.length);
assert.equal(result.selection.snapshot.count, result.snapshots.length);
assert.equal(result.selection.event.count, result.events.length);

// 近期忆泡：默认关；打开后排除已选中的，且名字按「先选中、后近期」的下标对齐。
const withRecent = await selectPromptMemoryContext({
  ...base,
  limits: { ...base.limits, recentEventDays: 3 },
  loadParticipantNames: async events => events.map((_, index) => [`名${index}`]),
});
const overlap = withRecent.events.filter(item => withRecent.recentEvents.some(recent => recent.id === item.id));
assert.deepEqual(overlap, [], "近期忆泡与命中忆泡不重复");
assert.deepEqual(withRecent.recentEvents[0]?.participants, [`名${withRecent.events.length}`],
  "近期忆泡的下标接在命中忆泡之后，不能用 0 重新开始");
assert.equal(withRecent.selection.recentEvent.count, withRecent.recentEvents.length);

// 首条永远放行：预算压到 1 token 也要留一条，否则「问了她却说没有」。
const squeezed = await selectPromptMemoryContext({
  ...base,
  limits: { ...base.limits, memoryTokens: 1, snapshotTokens: 1, eventTokens: 1 },
  loadParticipantNames: async events => events.map(() => []),
});
assert.equal(squeezed.memories.length, 1, "预算再紧也要留第一条记忆");
assert.equal(squeezed.snapshots.length, 1, "快照同理");

// 名字读失败（空数组）时退回忆泡自己的 participants，不能把名字吃掉。
const fallback = await selectPromptMemoryContext({ ...base, loadParticipantNames: async () => [] });
assert.deepEqual(fallback.events[0]?.participants, ["旧名"], "没有新名字时保留原 participants");

// 一条都没选中时不该去查名字表。
let lookedUp = false;
await selectPromptMemoryContext({
  ...base,
  query: "完全无关的问题",
  memoryCandidates: [],
  snapshotCandidates: [],
  eventCandidates: [],
  loadParticipantNames: async () => { lookedUp = true; return []; },
});
assert.equal(lookedUp, false, "空结果不触发参与者名字查询");

console.log("记忆选择层测试通过：范围标签、validFrom 回退、忆泡截断与改名、近期去重与下标对齐、首条保底、空结果不查库。");
