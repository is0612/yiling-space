import assert from "node:assert/strict";
import { interactionReviewPrompt, parseInteractionReview, reviewInteractionExperience } from "../server/utils/interaction-experience-review";
for (const status of ["ACTIVE", "PENDING", "REJECTED"] as const) assert.deepEqual(parseInteractionReview(JSON.stringify({ status, reason: "证据支持程度" })), { status, reason: "证据支持程度" });
for (const row of [{}, { status: "ACTIVE", reason: "" }, { status: "APPROVE", reason: "x" }, { status: "ACTIVE", reason: "x".repeat(601) }, []]) assert.throws(() => parseInteractionReview(JSON.stringify(row)));
assert.match(interactionReviewPrompt, /原始请求和前文/);
assert.match(interactionReviewPrompt, /不得修改候选/);
const original = globalThis.fetch;
let calls = 0;
try {
  globalThis.fetch = async (url, init) => {
    calls++;
    assert.equal(String(url), "http://127.0.0.1:4010/v1/chat/completions");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, "review-mock");
    assert.equal(body.messages[0].content, interactionReviewPrompt);
    assert.deepEqual(JSON.parse(body.messages[1].content), { candidate: "candidate", feedback: "evidence" });
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"status":"PENDING","reason":"原始反馈含义不明确"}' } }] }));
  };
  const result = await reviewInteractionExperience({ model: "review-mock", apiKey: "mock", apiBaseUrl: "http://127.0.0.1:4010/v1", evidence: { candidate: "candidate", feedback: "evidence" } });
  assert.equal(result.status, "PENDING");
  assert.equal(calls, 1);
  globalThis.fetch = async () => { calls++; throw new Error("mock failure"); };
  await assert.rejects(reviewInteractionExperience({ model: "review-mock", apiKey: "mock", apiBaseUrl: "http://127.0.0.1:4010/v1", evidence: {} }));
  assert.equal(calls, 2, "durable task owns retries, no hidden model retry");
} finally { globalThis.fetch = original; }
console.log("Interaction semantic review mock tests passed: strict decisions/reasons, independent prompt and evidence, failures never approve, no internal retries.");
