import assert from "node:assert/strict";
import { knowledgeItemPatchChanges, parseKnowledgeItemPatch } from "../server/utils/knowledge-item-versioning";

const parsed = parseKnowledgeItemPatch({
  revision: 3,
  title: "  新标题 ",
  content: " 修订后的说明 ",
  category: " SCIENCE ",
  tags: [" 天文学 ", "物理", "天文学"],
  confidence: 0.92,
});
assert.deepEqual(parsed, {
  expectedRevision: 3,
  patch: {
    title: "新标题",
    content: "修订后的说明",
    category: "SCIENCE",
    tags: ["天文学", "物理"],
    confidence: 0.92,
  },
});

assert.deepEqual(parseKnowledgeItemPatch({ revision: 1, confidence: null }), {
  expectedRevision: 1,
  patch: { confidence: null },
});
assert.throws(() => parseKnowledgeItemPatch(null), /提供要修改/);
assert.throws(() => parseKnowledgeItemPatch({ title: "缺少版本号" }), /版本号无效/);
assert.throws(() => parseKnowledgeItemPatch({ revision: 0, title: "x" }), /版本号无效/);
assert.throws(() => parseKnowledgeItemPatch({ revision: 1, title: " " }), /标题不能为空/);
assert.throws(() => parseKnowledgeItemPatch({ revision: 1, title: "x".repeat(241) }), /240 个字符/);
assert.throws(() => parseKnowledgeItemPatch({ revision: 1, content: "x".repeat(12_001) }), /12000 个字符/);
assert.throws(() => parseKnowledgeItemPatch({ revision: 1, category: "" }), /分类不能为空/);
assert.throws(() => parseKnowledgeItemPatch({ revision: 1, tags: "not-an-array" }), /标签必须/);
assert.throws(() => parseKnowledgeItemPatch({ revision: 1, tags: Array.from({ length: 21 }, () => "tag") }), /标签必须/);
assert.throws(() => parseKnowledgeItemPatch({ revision: 1, tags: ["x".repeat(41)] }), /标签不能超过/);
assert.throws(() => parseKnowledgeItemPatch({ revision: 1, confidence: 1.1 }), /可信度必须/);
assert.throws(() => parseKnowledgeItemPatch({ revision: 1, confidence: Number.NaN }), /可信度必须/);
assert.throws(() => parseKnowledgeItemPatch({ revision: 1, status: "ARCHIVED" }), /来源和系统字段不可编辑/);
assert.throws(() => parseKnowledgeItemPatch({ revision: 1, sourceRef: { url: "https://example.com" } }), /来源和系统字段不可编辑/);
assert.throws(() => parseKnowledgeItemPatch({ revision: 1 }), /可编辑的知识字段/);

const current = {
  title: "黑洞",
  content: "黑洞是时空中的极端天体。",
  category: "SCIENCE",
  tags: ["天文学"],
  confidence: 0.9,
};
assert.equal(knowledgeItemPatchChanges(current, { title: "新标题" }), true);
assert.equal(knowledgeItemPatchChanges(current, { tags: ["天文学"] }), false);
assert.equal(knowledgeItemPatchChanges(current, { confidence: null }), true);
assert.equal(knowledgeItemPatchChanges(current, { content: current.content }), false);

console.log("Knowledge versioning tests passed: validation, provenance protection, tag normalization and no-op detection.");
