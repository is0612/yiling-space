import assert from "node:assert/strict";
import {
  filterAssessmentEvidenceIds,
  normalizeSocialRelationshipAssessmentSuggestion,
} from "../server/utils/social-relationship-assessment-ai";

const freshId = "fresh-experience";
const contextId = "context-experience";

assert.deepEqual(
  filterAssessmentEvidenceIds([freshId, contextId, "invented", freshId], [freshId, contextId]),
  [freshId, contextId],
  "只能保留本轮真实挂接的经历 ID，并去重",
);

const contextOnlyChange = normalizeSocialRelationshipAssessmentSuggestion({
  outcome: "CHANGE",
  suggestedStage: "FRIEND",
  suggestedStatus: "NORMAL",
  reason: "仅凭历史背景想升级",
  confidence: 0.95,
  evidenceExperienceIds: [contextId, "invented"],
  newEvidenceExperienceIds: [],
}, {
  currentStage: "ACQUAINTANCE",
  currentStatus: "NORMAL",
  allowedEvidenceIds: [freshId, contextId],
  allowedNewEvidenceIds: [freshId],
});
assert.equal(contextOnlyChange.outcome, "REVIEW", "仅引用 CONTEXT 的变化建议必须降为待复核");
assert.deepEqual(contextOnlyChange.evidenceExperienceIds, [contextId], "伪造证据 ID 必须被过滤");
assert.equal(contextOnlyChange.suggestedStage, "FRIEND", "待复核可以保留建议供人工查看");

const groundedChange = normalizeSocialRelationshipAssessmentSuggestion({
  outcome: "CHANGE",
  suggestedStage: "FRIEND",
  suggestedStatus: "NORMAL",
  reason: "有新的、明确的互相支持经历",
  confidence: 0.8,
  evidenceExperienceIds: [freshId, contextId],
  newEvidenceExperienceIds: [freshId, contextId],
  observations: ["出现了持续的互相支持"],
}, {
  currentStage: "ACQUAINTANCE",
  currentStatus: "NORMAL",
  allowedEvidenceIds: [freshId, contextId],
  allowedNewEvidenceIds: [freshId],
});
assert.equal(groundedChange.outcome, "CHANGE", "引用真实 NEW 经历时可以形成变化建议");
assert.deepEqual(groundedChange.newEvidenceExperienceIds, [freshId], "CONTEXT 不得混入 NEW 引用");
assert.equal(groundedChange.confidence, 0.8);

const emptyChange = normalizeSocialRelationshipAssessmentSuggestion({
  outcome: "CHANGE",
  suggestedStage: "ACQUAINTANCE",
  suggestedStatus: "NORMAL",
  evidenceExperienceIds: [freshId],
  newEvidenceExperienceIds: [freshId],
}, {
  currentStage: "ACQUAINTANCE",
  currentStatus: "NORMAL",
  allowedEvidenceIds: [freshId],
  allowedNewEvidenceIds: [freshId],
});
assert.equal(emptyChange.outcome, "MAINTAIN", "建议值没有变化时应归一化为 MAINTAIN");

const insufficient = normalizeSocialRelationshipAssessmentSuggestion({
  outcome: "INSUFFICIENT",
  suggestedStage: "CLOSE_FRIEND",
  suggestedStatus: "CONFLICT",
  confidence: 5,
}, {
  currentStage: "STRANGER",
  currentStatus: "UNOBSERVED",
  allowedEvidenceIds: [],
  allowedNewEvidenceIds: [],
});
assert.equal(insufficient.suggestedStage, null, "证据不足时不能留下关系阶段建议");
assert.equal(insufficient.suggestedStatus, null, "证据不足时不能留下相处状态建议");
assert.equal(insufficient.confidence, 1, "信心值限制在 0..1");
console.log("社交关系评估 AI 协议单元测试通过。");
