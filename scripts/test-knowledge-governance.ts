import assert from "node:assert/strict";
import { parseKnowledgeMergeInput, parseKnowledgeRelationDecision } from "../server/utils/knowledge-item-governance";

const merge = parseKnowledgeMergeInput({
  targetItemId: "00000000-0000-4000-8000-000000000002",
  expectedSourceRevision: 3,
  expectedTargetRevision: 5,
  title: "  合并后的标题 ",
  content: " 合并后的完整正文 ",
  category: " SCIENCE ",
  tags: [" 天文学 ", "物理", "天文学"],
  confidence: 0.95,
});
assert.deepEqual(merge, {
  targetItemId: "00000000-0000-4000-8000-000000000002",
  expectedSourceRevision: 3,
  expectedTargetRevision: 5,
  title: "合并后的标题",
  content: "合并后的完整正文",
  category: "SCIENCE",
  tags: ["天文学", "物理"],
  confidence: 0.95,
});

assert.throws(() => parseKnowledgeMergeInput({ ...merge, expectedSourceRevision: 0 }), /源知识版本号无效/);
assert.throws(() => parseKnowledgeMergeInput({ ...merge, expectedTargetRevision: 1.2 }), /目标知识版本号无效/);
assert.throws(() => parseKnowledgeMergeInput({ ...merge, title: " " }), /标题不能为空/);
assert.throws(() => parseKnowledgeMergeInput({ ...merge, content: "x".repeat(12_001) }), /12000 个字符/);
assert.throws(() => parseKnowledgeMergeInput({ ...merge, tags: Array.from({ length: 21 }, () => "tag") }), /最多 20 个/);
assert.throws(() => parseKnowledgeMergeInput({ ...merge, confidence: 1.1 }), /可信度必须/);
assert.throws(() => parseKnowledgeMergeInput({ ...merge, status: "MERGED" }), /不允许修改/);

for (const action of ["CONFIRM_CONFLICT", "NEEDS_VERIFICATION", "KEEP_SEPARATE", "DISMISS"] as const) {
  assert.deepEqual(parseKnowledgeRelationDecision({
    action, expectedSourceRevision: 2, expectedTargetRevision: 4,
  }), { action, expectedSourceRevision: 2, expectedTargetRevision: 4 });
}
assert.throws(() => parseKnowledgeRelationDecision({ action: "MERGE" }), /请选择有效的关系处置方式/);
assert.throws(() => parseKnowledgeRelationDecision({
  action: "DISMISS", expectedSourceRevision: 1, expectedTargetRevision: 0,
}), /目标知识版本号无效/);
assert.throws(() => parseKnowledgeRelationDecision({
  action: "DISMISS", expectedSourceRevision: 1, expectedTargetRevision: 2, status: "RESOLVED",
}), /不允许的字段/);

console.log("Knowledge governance tests passed: merge payload validation, optimistic revisions and relation decisions.");
