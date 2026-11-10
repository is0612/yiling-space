import assert from "node:assert/strict";
import { resolveSocialAssessmentOutputBudget, nextSocialAssessmentOutputBudget } from "../server/utils/social-assessment-budget";

assert.equal(resolveSocialAssessmentOutputBudget(undefined), 8192);
assert.equal(resolveSocialAssessmentOutputBudget(16384), 16384);
assert.equal(resolveSocialAssessmentOutputBudget(99999), 32768);
assert.equal(nextSocialAssessmentOutputBudget(2048), 8192);
assert.equal(nextSocialAssessmentOutputBudget(6144), 18432);
assert.equal(nextSocialAssessmentOutputBudget(8192), 24576);
assert.equal(nextSocialAssessmentOutputBudget(16384), 32768);
assert.equal(nextSocialAssessmentOutputBudget(32768), null);
import {
  filterAssessmentEvidenceIds,
  normalizeSocialRelationshipAssessmentSuggestion,
  readAssessmentReply,
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

/**
 * 正文提取要认两种形态：
 * - `content` 是字符串（标准 OpenAI 兼容）；
 * - `content` 是 `[{ type: "text", text: "…" }]` 片段数组（部分兼容层这么回）。
 * 只认字符串时，第二种会被读成空正文，然后统一报「没有返回可解析的 JSON」——
 * 明明模型答对了，却看起来像模型什么都没说。
 */
const arrayContent = readAssessmentReply({
  choices: [{
    finish_reason: "stop",
    message: { content: [{ type: "text", text: '{"outcome":' }, { type: "text", text: '"MAINTAIN"}' }] },
  }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, completion_tokens_details: { reasoning_tokens: 4 } },
});
assert.equal(arrayContent.content, '{"outcome":"MAINTAIN"}', "片段数组形式的正文必须拼回完整 JSON");
assert.equal(arrayContent.finishReason, "stop");
assert.equal(arrayContent.reasoningTokens, 4, "思考 token 数要带出来，用于解释「预算被思考吃光」");

const truncatedReply = readAssessmentReply({
  choices: [{ finish_reason: "length", message: { content: "" } }],
  usage: { prompt_tokens: 4188, completion_tokens: 2048, total_tokens: 6236, completion_tokens_details: { reasoning_tokens: 2048 } },
});
assert.equal(truncatedReply.content, "", "思考吃光预算时正文为空");
assert.equal(truncatedReply.finishReason, "length", "截断原因必须能被读到，才能触发抬预算重试");
assert.equal(truncatedReply.reasoningTokens, 2_048);
assert.deepEqual(
  readAssessmentReply(null),
  { content: "", finishReason: "", reasoningTokens: 0 },
  "空响应不能抛异常，要落到可解释的失败路径",
);

console.log("社交关系评估 AI 协议单元测试通过。");
