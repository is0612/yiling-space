import assert from "node:assert/strict";
import {
  translateImagePromptToTags, clearTagTranslationCache,
} from "../server/utils/image-prompt-translation";

/**
 * 翻译失败要「再问一次」，而不是直接把中文原样塞进 Anima。
 *
 * 2026-11-24 的现场：模型其实答了，只是给了个 JSON/一句解释，旧解析器把整段判废，
 * 日志写「这次按原文送引擎」，于是出了四个小人鱼。这里用假模型服务覆盖三条路：
 * 第一次就答对不重问、第一次答坏但第二次答对要救回来、两次都坏才退回 null。
 */
const settings = { positive: "蓝紫色长发，雪中回头", negative: "多余手指", model: "mock", apiKey: "mock", apiBaseUrl: "https://mock.invalid/v1" };
const originalFetch = globalThis.fetch;
let replies: Array<{ status?: number; content?: string }> = [];
let calls = 0;
const answer = (content: string) => JSON.stringify({
  choices: [{ finish_reason: "stop", message: { content } }],
  usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
});

globalThis.fetch = async (_url, init) => {
  calls += 1;
  const body = JSON.parse(String((init as { body?: string })?.body ?? "{}"));
  assert.equal(Array.isArray(body.messages), true, "翻译走的是聊天补全。");
  const reply = replies.shift() ?? { content: "POSITIVE: 1girl, purple hair, looking back, snow\nNEGATIVE: bad anatomy" };
  if (reply.status && reply.status !== 200) return new Response("no", { status: reply.status });
  return Response.json(JSON.parse(answer(reply.content ?? "")));
};

try {
  clearTagTranslationCache();
  replies = [{ content: "POSITIVE: 1girl, purple hair, looking back, snow\nNEGATIVE: bad anatomy" }];
  calls = 0;
  assert.deepEqual(await translateImagePromptToTags(settings),
    { positive: "1girl, purple hair, looking back, snow", negative: "bad anatomy" }, "第一次答对就用第一次的结果。");
  assert.equal(calls, 1, "答对了不该多花一次调用。");

  // 同样的原文再来一次：形象档案没变，直接吃缓存。
  assert.deepEqual(await translateImagePromptToTags(settings),
    { positive: "1girl, purple hair, looking back, snow", negative: "bad anatomy" }, "缓存要命中。");
  assert.equal(calls, 1, "命中缓存后不能再调模型。");

  clearTagTranslationCache();
  // 第一次完全是中文废话（新解析器救不回来），第二次才按两行写。
  replies = [
    { content: "抱歉，我没办法把这段翻成标签，下面是我的一点说明。" },
    { content: "POSITIVE: 1girl, blue hair, looking back\nNEGATIVE: extra fingers" },
  ];
  calls = 0;
  assert.deepEqual(await translateImagePromptToTags({ ...settings, positive: "蓝色头发，回眸" }),
    { positive: "1girl, blue hair, looking back", negative: "extra fingers" }, "第一次坏、第二次好，要用第二次的。");
  assert.equal(calls, 2, "解析失败必须重问一次（不该是 1 次，也不该无限重试）。");

  clearTagTranslationCache();
  // 第一次直接 500，第二次正常：异常也要有第二次机会。
  replies = [{ status: 500 }, { content: "POSITIVE: 1girl, whale girl\nNEGATIVE: bad hands" }];
  calls = 0;
  assert.deepEqual(await translateImagePromptToTags({ ...settings, positive: "鲸鱼少女" }),
    { positive: "1girl, whale girl", negative: "bad hands" }, "第一次请求抛错也要重问一次。");
  assert.equal(calls, 2);

  clearTagTranslationCache();
  // 两次都坏：返回 null 交回原文，但这条失败不能进缓存（下次还要再试）。
  replies = [{ content: "我不会翻译" }, { content: "还是不会" }];
  calls = 0;
  assert.equal(await translateImagePromptToTags({ ...settings, positive: "一只猫" }), null, "两次都失败，按既有约定退回原文。");
  assert.equal(calls, 2);
  replies = [{ content: "POSITIVE: 1girl, cat\nNEGATIVE:" }];
  assert.deepEqual(await translateImagePromptToTags({ ...settings, positive: "一只猫" }),
    { positive: "1girl, cat", negative: "" }, "失败不进缓存，下一次仍然会重新翻。");
  assert.equal(calls, 3);

  console.log("Image prompt translation passed: tolerant parsing, one repair retry on bad output or request error, success-only cache, and null fallback after two failures.");
} finally {
  globalThis.fetch = originalFetch;
  clearTagTranslationCache();
}
