import assert from "node:assert/strict";
import {
  estimateTokens,
  MEMORY_TOKEN_BUDGET_DEFAULT,
  rankMemoriesWithBudget,
  rankSnapshotsWithBudget,
  RECENT_MESSAGE_LIMIT_DEFAULT,
  RECENT_MESSAGE_LIMIT_MAX,
  RECENT_MESSAGE_LIMIT_MIN,
  resolveMemoryItemLimit,
  resolveMemoryTokenBudget,
  resolveRecentMessageLimit,
  resolveSnapshotTokenBudget,
} from "../server/utils/memory-retrieval";

const now = Date.parse("2026-10-28T12:00:00+08:00");
const DAY = 86_400_000;
const daysAgo = (days: number) => new Date(now - days * DAY);

// ── token 估算 ──────────────────────────────────────────────
assert.equal(estimateTokens(""), 0, "空文本不占预算。");
assert.equal(estimateTokens("科幻电影很好看"), 7, "中文按 1 字 1 token。");
const english = estimateTokens("science fiction movies");
assert(english >= 4 && english <= 6, `英文按 4 字符 1 token 估算，实际 ${english}。`);
assert(estimateTokens("混合 text 内容") > 2, "中英混排也要给出合理估算。");

// ── 预算装配 ────────────────────────────────────────────────
const longMemory = { id: "long", content: "科幻电影".repeat(400), importance: 0.5, recallCount: 0, updatedAt: daysAgo(60) };
const shortMemory = { id: "short", content: "她喜欢科幻电影", importance: 0.5, recallCount: 0, updatedAt: daysAgo(1) };

const budgeted = rankMemoriesWithBudget("科幻电影", [longMemory, shortMemory], { tokenBudget: 200 });
assert.equal(budgeted.items[0]?.id, "short", "新鲜且短的记忆应排在最前。");
assert(budgeted.items.every((item) => item.tokens <= 200), "单条不能超过总预算。");
assert.equal(budgeted.dropped, 1, "被预算挤掉的条数要如实上报。");
assert(budgeted.usedTokens <= 200, "累计用量不能超过预算。");

const firstAlwaysIn = rankMemoriesWithBudget("科幻电影", [longMemory], { tokenBudget: 10 });
assert.equal(firstAlwaysIn.items.length, 1, "预算再小也要放行第一条，否则等于她什么都不记得。");
assert(firstAlwaysIn.items[0]!.tokens > 10, "放行的确超了预算 —— 这是有意的例外。");

// ── 时间衰减 ────────────────────────────────────────────────
const oldSame = { id: "old", content: "科幻电影讨论", importance: 0.5, recallCount: 0, updatedAt: daysAgo(120) };
const newSame = { id: "new", content: "科幻电影讨论", importance: 0.5, recallCount: 0, updatedAt: daysAgo(0) };
const decayRank = rankMemoriesWithBudget("科幻电影", [oldSame, newSame]).items;
assert.equal(decayRank[0]?.id, "new", "同样相关时，新记忆优先。");
assert(
  (decayRank.find((item) => item.id === "old")?.decay ?? 1) < (decayRank.find((item) => item.id === "new")?.decay ?? 0),
  "旧记忆的衰减系数应更低。",
);

// ── 重要度能压过新鲜度 ──────────────────────────────────────
const importantOld = { id: "important", content: "科幻电影讨论", importance: 1, recallCount: 0, updatedAt: daysAgo(30) };
const trivialNew = { id: "trivial", content: "科幻电影讨论", importance: 0.2, recallCount: 0, updatedAt: daysAgo(0) };
const importanceRank = rankMemoriesWithBudget("科幻电影", [importantOld, trivialNew]).items;
assert.equal(importanceRank[0]?.id, "important", "重要度高的旧记忆可以排在前面。");

// ── 召回次数加成 ────────────────────────────────────────────
const oftenUsed = { id: "often", content: "科幻电影讨论", importance: 0.5, recallCount: 10, updatedAt: daysAgo(5) };
const neverUsed = { id: "never", content: "科幻电影讨论", importance: 0.5, recallCount: 0, updatedAt: daysAgo(5) };
const recallRank = rankMemoriesWithBudget("科幻电影", [oftenUsed, neverUsed]).items;
assert.equal(recallRank[0]?.id, "often", "被反复用到的记忆应获得加成。");

// ── 条数上限 ────────────────────────────────────────────────
const many = Array.from({ length: 5 }, (_, index) => ({
  id: `m${index}`, content: "科幻电影讨论", importance: 0.5, recallCount: 0, updatedAt: daysAgo(index),
}));
const limited = rankMemoriesWithBudget("科幻电影", many, { limit: 2 });
assert.equal(limited.items.length, 2, "limit 必须生效。");
assert.equal(limited.dropped, 3, "超出 limit 的数量要计入 dropped。");

// ── 相关度为零时不返回 ──────────────────────────────────────
assert.equal(
  rankMemoriesWithBudget("今天天气怎么样", [shortMemory]).items.length,
  0,
  "无关内容不该为了凑预算被塞进来。",
);

// ── 快照独立预算 ────────────────────────────────────────────
const longSnapshot = { id: "s-long", summary: "科幻电影".repeat(800), createdAt: daysAgo(3) };
const shortSnapshot = { id: "s-short", summary: "聊过科幻电影", createdAt: daysAgo(1) };
const snapshotRank = rankSnapshotsWithBudget("科幻电影", [longSnapshot, shortSnapshot], { tokenBudget: 300 });
assert.equal(snapshotRank.items.length, 1, "长总结会吃满预算，短的才能进来。");
assert.equal(snapshotRank.items[0]?.id, "s-short", "只有短总结进得来。");
assert.equal(snapshotRank.dropped, 1, "被预算挤掉的快照要计数。");

// ── 配置解析 ────────────────────────────────────────────────
assert.equal(resolveMemoryTokenBudget({}), MEMORY_TOKEN_BUDGET_DEFAULT, "缺省预算取默认值。");
assert.equal(resolveMemoryTokenBudget({ memoryTokenBudget: 3000 }), 3000, "读得到自定义预算。");
assert.equal(resolveMemoryTokenBudget({ memoryTokenBudget: -1 }), MEMORY_TOKEN_BUDGET_DEFAULT, "非法值回落默认。");
assert.equal(resolveSnapshotTokenBudget({ snapshotTokenBudget: 500 }), 500, "快照预算独立读取。");
assert.equal(resolveMemoryItemLimit({}), 12, "条数上限默认 12。");
assert.equal(resolveMemoryItemLimit({ memoryItemLimit: 3 }), 3, "条数上限可配。");

// ── 最近对话窗口 ────────────────────────────────────────────
assert.equal(resolveRecentMessageLimit({}), RECENT_MESSAGE_LIMIT_DEFAULT, "窗口默认 40 条。");
assert.equal(resolveRecentMessageLimit({ recentMessageLimit: 80 }), 80, "窗口条数可配。");
assert.equal(resolveRecentMessageLimit({ recentMessageLimit: 9999 }), RECENT_MESSAGE_LIMIT_MAX, "超过上限要夹住。");
assert.equal(resolveRecentMessageLimit({ recentMessageLimit: 3 }), RECENT_MESSAGE_LIMIT_MIN, "低于下限要夹住。");
assert.equal(resolveRecentMessageLimit({ recentMessageLimit: "abc" }), RECENT_MESSAGE_LIMIT_DEFAULT, "非法值回落默认。");

console.log("记忆预算与衰减测试通过：token 估算、预算装配、首条保底、时间衰减、重要度加权、召回加成、条数上限、快照独立预算、最近对话窗口。");
