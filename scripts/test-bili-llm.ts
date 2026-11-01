/**
 * B站值班模型调用的回归测试。
 *
 * 守的是真实事故（2026-10-28，一天内连着踩了两个）：
 *   1. 值班复用聊天的 `generateConversationReply`：强制 `response_format: json_object` 并要
 *      `{reply, usedMemoryIds, ...}`，而粗筛题目要「只输出 BV 数组」—— 模型回数组，封装解不出
 *      reply 就抛错，粗筛整轮为空，所有候选记成「粗筛没留」。
 *   2. 换成裸文本调用后又踩到：**思考型模型先把 max_tokens 花在思考上**。
 *      25 条候选时 reasoning_tokens 就吃掉 800，`finish_reason=length`、正文全空。
 *
 * 这里要钉住的：
 *   - 不发 response_format（不再逼模型包 JSON 对象）
 *   - 裸文本（数组 / 三行）原样返回
 *   - 正文为空且被 length 截断时，自动加预算重试，而不是让整轮白跑
 *   - 仍然空时，错误里要说清是「预算不够」还是「没内容」
 */

import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { callBiliModel } from "../server/utils/channel-adapter/bili/llm";
import { extractBvids } from "../server/utils/channel-adapter/bili/cards";
import { parseJsonLoose } from "../server/utils/loose-json";

type MockReply = { status?: number; content?: string; finishReason?: string; reasoningTokens?: number };

const requests: Array<Record<string, unknown>> = [];
let queue: MockReply[] = [];
let auth: string | undefined;

const server = http.createServer(async (request, response) => {
  auth = request.headers.authorization as string | undefined;
  let raw = "";
  for await (const chunk of request) raw += chunk;
  try {
    requests.push(JSON.parse(raw) as Record<string, unknown>);
  } catch {
    requests.push({});
  }
  const reply = queue.shift() ?? { content: "" };
  response.writeHead(reply.status ?? 200, { "content-type": "application/json" });
  response.end(JSON.stringify({
    model: "mock-model",
    choices: [{
      index: 0,
      message: { role: "assistant", content: reply.content ?? "", reasoning_content: "内部思考……" },
      finish_reason: reply.finishReason ?? "stop",
    }],
    usage: { completion_tokens_details: { reasoning_tokens: reply.reasoningTokens ?? 0 } },
  }));
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as AddressInfo).port;
const apiBaseUrl = `http://127.0.0.1:${port}/v1`;

function call(overrides: Partial<Parameters<typeof callBiliModel>[0]> = {}) {
  return callBiliModel({
    systemPrompt: "你是这个账号的 B站 助手。",
    userPrompt: "只输出一个 JSON 数组，元素是 BV 号。",
    model: "mock-model",
    apiKey: "test-key",
    apiBaseUrl,
    ...overrides,
  });
}

async function main() {
  // 1. 裸数组（正是当年把聊天封装噎死的形状）
  queue = [{ content: '["BV1xx411c7mD","BV1aa411c7mE"]' }];
  const text = await call();
  assert.equal(text, '["BV1xx411c7mD","BV1aa411c7mE"]', "裸数组要原样返回，不能被 JSON 对象契约吃掉");
  assert.deepEqual(parseJsonLoose(text), ["BV1xx411c7mD", "BV1aa411c7mE"]);
  assert.deepEqual(extractBvids(text), ["BV1xx411c7mD", "BV1aa411c7mE"]);

  // 2. 不能带 response_format —— 带上就等于又把模型逼回 JSON 对象
  const body = requests.at(-1);
  assert.ok(body, "请求体要是合法 JSON");
  assert.equal(body?.response_format, undefined, "值班调用不应强制 response_format");
  assert.equal(body?.model, "mock-model");
  assert.equal(auth, "Bearer test-key");
  assert.ok(Number(body?.max_tokens) >= 4096, "默认预算要够思考型模型用");

  // 3. 三行文本（终判的形状）：原样返回
  queue = [{ content: "判断：跳过\n理由：负面\n评论：无" }];
  assert.match(await call({ maxTokens: 2048 }), /判断：跳过/);

  // 4. 思考吃光 token（正文为空 + finish_reason=length）→ 自动加预算重试
  requests.length = 0;
  queue = [
    { content: "", finishReason: "length", reasoningTokens: 800 },
    { content: '["BV1xx411c7mD"]' },
  ];
  const rescued = await call({ maxTokens: 800 });
  assert.equal(rescued, '["BV1xx411c7mD"]', "被思考截断时应加预算重试一次");
  assert.equal(requests.length, 2, "应该正好重试一次");
  assert.ok(Number(requests[1]?.max_tokens) > Number(requests[0]?.max_tokens), "重试要给更大的预算");

  // 5. 重试还是空 → 错误里要说清是「思考吃光了预算」
  requests.length = 0;
  queue = [
    { content: "", finishReason: "length", reasoningTokens: 800 },
    { content: "", finishReason: "length", reasoningTokens: 3000 },
  ];
  await assert.rejects(
    () => call({ maxTokens: 800 }),
    (error: Error) => /LLM_EMPTY_REPLY/.test(error.message)
      && /length/.test(error.message)
      && /思考/.test(error.message),
    "两次都空时要指出是预算问题",
  );

  // 6. HTTP 错误要有明确错误码
  queue = [{ status: 401, content: "" }];
  await assert.rejects(() => call(), /LLM_HTTP_ERROR/);

  // 7. 没有思考过程、纯空回复 —— 不要误报成预算问题
  queue = [{ content: "", finishReason: "stop" }];
  await assert.rejects(
    () => call(),
    (error: Error) => /LLM_EMPTY_REPLY/.test(error.message) && /stop/.test(error.message),
  );

  // 8. 没配 key 直接报配置错误
  await assert.rejects(() => call({ apiKey: "" }), /LLM_NOT_CONFIGURED/);

  console.log("✅ test-bili-llm 全部通过");
  console.log("   裸文本（数组 / 三行）原样返回：通过");
  console.log("   不带 response_format、默认预算 ≥ 4096：通过");
  console.log("   思考截断时自动加预算重试：通过");
  console.log("   HTTP / 空回复 / 思考吃光预算 / 未配置 的错误码：通过");
}

main()
  .catch((error) => {
    console.error("❌ test-bili-llm 失败：", error);
    process.exitCode = 1;
  })
  .finally(() => server.close());
