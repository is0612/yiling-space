import assert from "node:assert/strict";
import { isNearDuplicateMemory, validateMemoryAiOutput } from "../server/utils/memory-ai";

const validIds = ["message-a", "message-b"];
const activeIds = ["memory-1"];
const globalIds = ["global-1"];
const parsed = validateMemoryAiOutput({
  summary: "用户明确表达了对简洁回答的偏好。",
  importantEvents: [{ title: "偏好确认", detail: "用户提出希望简洁回答。", evidenceMessageIds: ["message-a", "fake-id"] }],
  factAndPreferenceChanges: [],
  relationshipChanges: [],
  goalsAndCommitments: [],
  unresolvedTopics: [],
  differencesFromPrevious: ["表达偏好更明确"],
  memoryChanges: [
    {
      action: "ADD",
      category: "PREFERENCE",
      content: "用户偏好简洁回答。",
      confidence: 0.96,
      importance: 0.9,
      evidenceMessageIds: ["message-a", "fake-id"],
    },
    {
      action: "UPDATE",
      category: "FACT",
      content: "新事实",
      confidence: 0.9,
      relatedMemoryId: "unknown-memory",
      evidenceMessageIds: ["message-b"],
    },
    {
      action: "INVALIDATE",
      category: "FACT",
      content: "旧事实不再成立",
      confidence: 0.85,
      // 越界的分数截断到 1，而不是整条丢掉 —— 分数只是排序参考。
      importance: 1.7,
      relatedMemoryId: "memory-1",
      evidenceMessageIds: ["message-b"],
    },
    {
      action: "ADD",
      category: "FACT",
      content: "关于她自己的稳定事实",
      confidence: 0.95,
      importance: 0.8,
      scope: "character",
      evidenceMessageIds: ["message-a"],
    },
    {
      action: "ADD",
      category: "FACT",
      content: "范围写错的记忆",
      confidence: 0.95,
      scope: "global",
      evidenceMessageIds: ["message-a"],
    },
    {
      action: "INVALIDATE",
      category: "FACT",
      content: "旧的全局记忆不再成立",
      confidence: 0.9,
      relatedMemoryId: "global-1",
      evidenceMessageIds: ["message-b"],
    },
    {
      action: "ADD",
      category: "FACT",
      content: "没有来源的记忆",
      confidence: 0.99,
      evidenceMessageIds: ["not-a-real-message"],
    },
  ],
}, validIds, activeIds, globalIds);

assert.equal(parsed.summary, "用户明确表达了对简洁回答的偏好。");
assert.deepEqual(parsed.importantEvents[0]?.evidenceMessageIds, ["message-a"]);
assert.equal(parsed.memoryChanges.length, 5, "Invalid or untraceable changes must be rejected.");
assert.deepEqual(parsed.memoryChanges[0]?.evidenceMessageIds, ["message-a"]);
assert.equal(parsed.memoryChanges[1]?.relatedMemoryId, "memory-1");
assert.equal(parsed.memoryChanges[0]?.importance, 0.9, "模型给的 importance 要原样带出来");
assert.equal(parsed.memoryChanges[1]?.importance, 1, "越界的 importance 截断到 1，不丢整条");
assert.equal(parsed.memoryChanges[2]?.scope, "character", "关于她自己的稳定事实可以写全局");
assert.equal(parsed.memoryChanges[3]?.scope, undefined, "不认识的 scope 一律按当前范围，不许跨范围写入");
assert.equal(parsed.memoryChanges[4]?.relatedMemoryId, "global-1", "INVALIDATE 可以指向全局记忆");

// ── 近似判重：同类别 + 字面高度重合 ──────────────────────────
assert.equal(
  isNearDuplicateMemory(
    { category: "FACT", content: "她原本没有语音功能，只能打字" },
    { category: "FACT", content: "她原本没有语音功能，只能打字的，表情包只有一张" },
  ),
  true,
  "同一件事多了半句 → 判重（快照重跑最常见的形态）",
);
assert.equal(
  isNearDuplicateMemory(
    { category: "FACT", content: "她原本没有语音功能，只能打字" },
    { category: "PREFERENCE", content: "她原本没有语音功能，只能打字" },
  ),
  false,
  "类别不同不算重复 —— 同一句话可以既是事实也是偏好",
);
assert.equal(
  isNearDuplicateMemory(
    { category: "FACT", content: "主人承诺两天内修好记忆功能" },
    { category: "FACT", content: "主人今天吃了两碗饭" },
  ),
  false,
  "不相干的两条不能被合并",
);
// 已知边界：真正的改写（换词、换语序）挡不住，那要语义向量，不在这里假装能。
assert.equal(
  isNearDuplicateMemory(
    { category: "FACT", content: "她原本没有语音功能，只能打字" },
    { category: "FACT", content: "她只会发文字" },
  ),
  false,
  "换了个说法的不判重 —— 这里只做确定性判重，宁可漏",
);

console.log("Memory AI output validation tests passed.");
