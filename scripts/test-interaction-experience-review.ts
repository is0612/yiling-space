import assert from "node:assert/strict";
import { interactionReviewPrompt, parseInteractionReview, reviewInteractionExperience } from "../server/utils/interaction-experience-review";
import { interactionExperiencePrompt, parseInteractionSuggestion } from "../server/utils/interaction-experiences";
for (const status of ["ACTIVE", "PENDING", "REJECTED"] as const) assert.deepEqual(parseInteractionReview(JSON.stringify({ status, reason: "证据支持程度", attribution: "USER_SUPPORTED", feedbackQuote: "先说结论" }), "请先说结论"), { status, reason: "证据支持程度" });
for (const row of [{}, { status: "ACTIVE", reason: "" }, { status: "APPROVE", reason: "x" }, { status: "ACTIVE", reason: "x".repeat(601) }, []]) assert.throws(() => parseInteractionReview(JSON.stringify(row)));
assert.match(interactionReviewPrompt, /原始请求和前文/);
assert.match(interactionReviewPrompt, /不得修改候选/);
assert.match(interactionReviewPrompt, /用户追问例子、询问原因或引用助手说法，不等于确认该说法/);
assert.match(interactionExperiencePrompt, /不得把仅来自助手的未确认前提写入/);
const original = globalThis.fetch;
let calls = 0;
const feedback = "举一个具体的例子";
const candidate = parseInteractionSuggestion(JSON.stringify({ content: "先承认旧记录永远不可读", context: "用户追问经历", feedbackQuote: feedback, learning: { kind: "STRATEGY", situation: "用户追问经历", misunderstanding: "没有说明记录不可读", correction: "旧记录永远不可读", nextJudgment: "先承认旧记录永远不可读" } }), feedback);
const evidence = { messages: [{ id: "a", role: "ASSISTANT", content: "旧记录永远不可读" }, { id: "f", role: "USER", content: feedback }], assistant: { id: "a", content: "旧记录永远不可读" }, feedback: { id: "f", content: feedback }, candidate };
const decisions = [
  { status: "ACTIVE", reason: "引用存在就通过" }, // The old protocol activated this unsupported premise.
  { status: "ACTIVE", reason: "错误放行", attribution: "ASSISTANT_ONLY", feedbackQuote: feedback },
  { status: "ACTIVE", reason: "归因不确定", attribution: "UNCERTAIN", feedbackQuote: feedback },
  { status: "ACTIVE", reason: "引用了助手而非用户", attribution: "USER_SUPPORTED", feedbackQuote: "旧记录永远不可读" },
  { status: "ACTIVE", reason: "仅空白不能证明支持", attribution: "USER_SUPPORTED", feedbackQuote: " " },
  { status: "ACTIVE", reason: "未知归因不能放行", attribution: "CONFIRMED", feedbackQuote: feedback },
];
try {
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "http://127.0.0.1:4010/v1/chat/completions");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, "review-mock");
    assert.equal(body.messages[0].content, interactionReviewPrompt);
    assert.deepEqual(JSON.parse(body.messages[1].content), evidence);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(decisions[calls++]) } }] }));
  };
  const run = () => reviewInteractionExperience({ model: "review-mock", apiKey: "mock", apiBaseUrl: "http://127.0.0.1:4010/v1", evidence });
  for (const expected of ["PENDING", "REJECTED", "PENDING", "PENDING", "PENDING", "PENDING"]) assert.equal((await run()).status, expected);
  assert.equal(calls, decisions.length, "attribution validation adds no model call or hidden retry");
  assert.equal(parseInteractionReview(JSON.stringify({ status: "ACTIVE", reason: "用户明确纠正顺序", attribution: "USER_SUPPORTED", feedbackQuote: "先说结论" }), "请先说结论，再讲背景").status, "ACTIVE", "specific supported correction can still activate");
  assert.equal(parseInteractionReview(JSON.stringify({ status: "PENDING", reason: "含义不明确", attribution: "UNCERTAIN", feedbackQuote: "" })).status, "PENDING");
  assert.equal(parseInteractionReview(JSON.stringify({ status: "REJECTED", reason: "没有反馈" })).status, "REJECTED");
  globalThis.fetch = async () => { calls++; throw new Error("mock failure"); };
  await assert.rejects(run());
  assert.equal(calls, decisions.length + 1, "durable task owns retries, no hidden model retry");
} finally { globalThis.fetch = original; }
console.log("Interaction semantic review tests passed: quoted assistant-only premise cannot auto-activate, missing/unknown attribution and unverified quotes stay pending, supported correction passes, no network/database/model calls.");
