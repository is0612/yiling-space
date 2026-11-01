import assert from "node:assert/strict";
import { validateMemoryAiOutput } from "../server/utils/memory-ai";

const validIds = ["message-a", "message-b"];
const activeIds = ["memory-1"];
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
      relatedMemoryId: "memory-1",
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
}, validIds, activeIds);

assert.equal(parsed.summary, "用户明确表达了对简洁回答的偏好。");
assert.deepEqual(parsed.importantEvents[0]?.evidenceMessageIds, ["message-a"]);
assert.equal(parsed.memoryChanges.length, 2, "Invalid or untraceable changes must be rejected.");
assert.deepEqual(parsed.memoryChanges[0]?.evidenceMessageIds, ["message-a"]);
assert.equal(parsed.memoryChanges[1]?.relatedMemoryId, "memory-1");
console.log("Memory AI output validation tests passed.");
