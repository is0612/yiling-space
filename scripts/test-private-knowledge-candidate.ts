import assert from "node:assert/strict";
import {
  analyzePrivateKnowledgeCandidate,
  CONTEXT_ASSISTANT_DEFAULTS,
  shouldConsiderPrivateKnowledgeCandidate,
  type PrivateKnowledgeMessage,
} from "../server/utils/context-assistant";
import type { MemoryAssistantRuntime } from "../server/utils/memory-assistant";

const runtime: MemoryAssistantRuntime = {
  model: "context-model", apiKey: "private-context-key", apiBaseUrl: "https://context.invalid/v1",
  ...CONTEXT_ASSISTANT_DEFAULTS,
};
const message = (content: string, id = "m1"): PrivateKnowledgeMessage => ({ id, speaker: "好友甲", content });

assert.equal(shouldConsiderPrivateKnowledgeCandidate([message("你好呀，今天怎么样？")]), false);
assert.equal(shouldConsiderPrivateKnowledgeCandidate([message("哈哈哈哈，笑死我了")]), false);
assert.equal(shouldConsiderPrivateKnowledgeCandidate([message("今天有点累，想早点睡觉")]), false);
assert.equal(shouldConsiderPrivateKnowledgeCandidate([message("什么是 TypeScript 的泛型？能解释一下吗？")]), true);
assert.equal(shouldConsiderPrivateKnowledgeCandidate([message("这个报错其实是因为异步函数没有 await，需要先等待结果")]), true);
assert.equal(shouldConsiderPrivateKnowledgeCandidate([message("How to use a promise in JavaScript?")]), true);

const originalFetch = globalThis.fetch;
let requestBody: { messages: Array<{ role: string; content: string }> } | undefined;
try {
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), "https://context.invalid/v1/chat/completions");
    const headers = options?.headers as Record<string, string>;
    assert.equal(headers.authorization, "Bearer private-context-key");
    requestBody = JSON.parse(String(options?.body));
    return Response.json({
      choices: [{ finish_reason: "stop", message: { content: JSON.stringify({
        knowledgeCandidate: { evidenceMessageIds: ["m1", "fake", "m1"], reason: "解释了可复用的泛型概念。" },
        reply: "must not be trusted",
      }) } }],
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
    });
  };
  const result = await analyzePrivateKnowledgeCandidate(runtime, "小鲸鱼i", [
    message("什么是 TypeScript 的泛型？能解释一下吗？", "m1"),
    message("这是另一个好友的内容，不应被传入。", "m2"),
  ]);
  assert.deepEqual(result.evidenceMessageIds, ["m1"]);
  assert.equal(result.reason, "解释了可复用的泛型概念。");
  assert.equal(result.usage?.totalTokens, 30);
  const serialized = JSON.stringify(requestBody);
  assert(serialized.includes("m1"));
  assert(serialized.includes("m2"));
  assert(!serialized.includes("SECRET"));
  assert.match(requestBody!.messages[0]!.content, /private conversation/u);
  assert.match(requestBody!.messages[0]!.content, /Do not turn personal details/u);
  console.log("Private knowledge candidate tests passed (mocked; no real model calls).");
} finally {
  globalThis.fetch = originalFetch;
}
