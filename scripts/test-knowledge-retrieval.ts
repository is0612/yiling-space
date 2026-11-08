import assert from "node:assert/strict";
import { rankKnowledgeItems } from "../server/utils/knowledge-retrieval";

const items = [
  { id: "a", title: "黑洞是什么", content: "黑洞是时空中引力极强的区域，连光也无法逃逸。", category: "SCIENCE", tags: ["天文学"], confidence: 0.95, updatedAt: new Date("2026-11-01") },
  { id: "b", title: "望远镜使用", content: "观测星空时先校准焦距。", category: "SKILL", tags: ["天文学", "观测"], confidence: 0.8, updatedAt: new Date("2026-11-02") },
  { id: "c", title: "TypeScript 类型收窄", content: "使用 typeof 和判别联合缩小类型范围。", category: "TECHNOLOGY", tags: ["TypeScript"], confidence: 0.9, updatedAt: new Date("2026-11-03") },
];
const astronomy = rankKnowledgeItems("黑洞是什么", items, 8);
assert.equal(astronomy[0]?.id, "a");
assert.ok(astronomy.some(item => item.id === "b"));
assert.deepEqual(rankKnowledgeItems("TypeScript", items, 8).map(item => item.id), ["c"]);
assert.deepEqual(rankKnowledgeItems("", items, 8), []);
assert.equal(rankKnowledgeItems("天文学", items, 1).length, 1);
console.log("Knowledge retrieval tests passed: Chinese bigrams, exact phrase weighting, tags and limits.");
