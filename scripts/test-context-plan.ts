import assert from "node:assert/strict";
import { fillContextPlanUsage, planContextTurn, type ContextPlanInput } from "../server/utils/context-plan";
import { sanitizeModelTurnDetail } from "../server/utils/model-turn-detail";

const limits: ContextPlanInput["limits"] = {
  recentMessages: 40,
  memoryItems: 20,
  memoryTokens: 1800,
  snapshotItems: 4,
  snapshotTokens: 2500,
  eventItems: 8,
  eventTokens: 800,
  rawMessageItems: 6,
  rawMessageTokens: 900,
};
const base: ContextPlanInput = { surface: "desktop", isOwner: true, questionKind: "none", limits };
const sources = (plan: ReturnType<typeof planContextTurn>) => plan.segments.map(segment => segment.source);
const segment = (plan: ReturnType<typeof planContextTurn>, source: string) =>
  plan.segments.find(item => item.source === source);

// 固定样例一：普通闲聊 —— 不带原文兜底、不带跨窗口。
const smallTalk = planContextTurn(base);
assert.deepEqual(sources(smallTalk), ["recentMessages", "memory", "snapshot", "event"]);
assert.equal(segment(smallTalk, "event")?.reason, "always", "没有日期/人物指向时忆泡段按背景处理");

// 固定样例二：问某一天 —— 才带原文兜底，忆泡按日期。
const byDate = planContextTurn({ ...base, questionKind: "date" });
assert.deepEqual(sources(byDate), ["recentMessages", "memory", "snapshot", "event", "rawMessage"]);
assert.equal(segment(byDate, "event")?.reason, "question_has_date");
assert.equal(segment(byDate, "rawMessage")?.reason, "question_has_date");

// 固定样例三：问某人 —— 走话题，不查原文。
const byPerson = planContextTurn({ ...base, questionKind: "topic" });
assert.deepEqual(sources(byPerson), ["recentMessages", "memory", "snapshot", "event"]);
assert.equal(segment(byPerson, "event")?.reason, "question_has_topic");

// 固定样例四：主人私聊 —— 多一段跨窗口旁路，额度写死 16 条 / 600 token。
const ownerPrivate = planContextTurn({ ...base, surface: "private", isOwner: true });
const cross = segment(ownerPrivate, "crossChannel");
assert(cross, "主人私聊要带跨窗口旁路");
assert.equal(cross.reason, "owner_cross_channel");
assert.deepEqual({ budget: cross.budget, limit: cross.limit }, { budget: 600, limit: 16 });

// 别人的私聊、群聊都不该出现这一段（群聊一屋子人，私聊内容不上桌）。
assert(!sources(planContextTurn({ ...base, surface: "private", isOwner: false })).includes("crossChannel"));
assert(!sources(planContextTurn({ ...base, surface: "group" })).includes("crossChannel"));

// 固定样例五：知识库还没接进来时永远没有 knowledge 段；接了才按命中带。
assert(!sources(smallTalk).includes("knowledge"));
assert(sources(planContextTurn({ ...base, hasKnowledgeHit: true })).includes("knowledge"));

// 预算总额 = 各段预算之和；最近对话与知识按条数控制，不占 token 预算。
assert.equal(smallTalk.totalBudget, 1800 + 2500 + 800);
assert.equal(byDate.totalBudget, 1800 + 2500 + 800 + 900);

// 用量回填：缺的段记 0 而不是丢段，这样「配了没用上」看得见。
const usage = fillContextPlanUsage(byDate, { memory: { used: 1204, items: 6 } });
const memorySegment = usage.segments.find(item => item.source === "memory");
assert.deepEqual({ used: memorySegment?.used, items: memorySegment?.items }, { used: 1204, items: 6 });
for (const item of usage.segments.filter(entry => entry.source !== "memory")) {
  assert.equal(item.used, 0);
  assert.equal(item.items, 0);
}
assert.equal(usage.segments.length, byDate.segments.length, "回填用量不能改变计划里的段数");

// 顺序是写死的：最近对话在最前，记忆在快照之前。
assert.deepEqual(sources(smallTalk), ["recentMessages", "memory", "snapshot", "event"]);

// 落盘清洗：只认白名单里的来源与理由，数值夹住，缺字段的段丢掉。
const kept = sanitizeModelTurnDetail({
  version: 1, groupChat: false, messages: [], context: { status: "success" }, memory: { status: "success" }, response: { status: "success" },
  contextPlan: {
    surface: "private", totalBudget: 5100,
    segments: [
      { source: "memory", reason: "always", budget: 1800, limit: 20, used: 1204, items: 6, optional: true },
      { source: "unknownSource", reason: "always", budget: 1, limit: 1, used: 1, items: 1 },
      { source: "event", reason: "made_up", budget: 1, limit: 1, used: 1, items: 1 },
      { source: "snapshot", reason: "always", budget: -5, limit: 4, used: 1e9, items: 2 },
    ],
  },
});
assert.equal(kept.contextPlan?.surface, "private");
assert.equal(kept.contextPlan?.totalBudget, 5100);
assert.equal(kept.contextPlan?.segments.length, 2, "未知来源与未知理由整段丢弃");
assert.deepEqual(kept.contextPlan?.segments[0], { source: "memory", reason: "always", budget: 1800, limit: 20, used: 1204, items: 6, optional: true });
assert.deepEqual(
  { budget: kept.contextPlan?.segments[1]?.budget, used: kept.contextPlan?.segments[1]?.used },
  { budget: 0, used: 100_000 },
  "负数夹到 0，超大值夹到上限",
);
assert.equal(sanitizeModelTurnDetail({ version: 1, groupChat: false, messages: [], context: {}, memory: {}, response: {}, contextPlan: { surface: "desktop", totalBudget: 1, segments: [] } }).contextPlan, undefined, "空段列表整块丢弃");

console.log("装配计划测试通过：五种固定样例的段与理由、跨窗口只看主人私聊、知识按命中、预算求和、用量回填不丢段、落盘白名单与数值夹取。");
