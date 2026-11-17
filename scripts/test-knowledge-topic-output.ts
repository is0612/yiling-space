import assert from "node:assert/strict";
import { validateKnowledgeTopicOutput } from "../server/utils/knowledge-topic-worker";

const a = "11111111-1111-4111-8111-111111111111";
const b = "22222222-2222-4222-8222-222222222222";
const c = "33333333-3333-4333-8333-333333333333";
const d = "44444444-4444-4444-8444-444444444444";
const allowed = [a, b, c, d];

assert.deepEqual(validateKnowledgeTopicOutput({
  topics: [
    { name: "主题 A", description: "说明", reason: "理由", itemIds: [a, b] },
    { name: "主题 B", description: "", reason: "理由", itemIds: [b, c] },
  ],
  ungroupedIds: [d],
}, allowed), {
  topics: [
    { name: "主题 A", description: "说明", reason: "理由", itemIds: [a, b] },
    { name: "主题 B", description: "", reason: "理由", itemIds: [b, c] },
  ],
  ungroupedIds: [d],
});
assert.throws(() => validateKnowledgeTopicOutput({ topics: [{ name: "x", description: "", reason: "r", itemIds: [a, a] }], ungroupedIds: [b, c, d] }, allowed));
assert.throws(() => validateKnowledgeTopicOutput({ topics: [{ name: "x", description: "", reason: "r", itemIds: [a, "99999999-9999-4999-8999-999999999999"] }], ungroupedIds: [b, c, d] }, allowed));
assert.throws(() => validateKnowledgeTopicOutput({ topics: [{ name: "x", description: "", reason: "r", itemIds: [a, b] }], ungroupedIds: [b, c, d] }, allowed));
assert.throws(() => validateKnowledgeTopicOutput({ topics: [{ name: "x", description: "", reason: "r", itemIds: [a, b] }], ungroupedIds: [c] }, allowed));
assert.throws(() => validateKnowledgeTopicOutput({ topics: [], ungroupedIds: [a, b, c, d] }, allowed));
console.log("knowledge topic output validation passed");
