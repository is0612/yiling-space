import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildModelFailureReply, MODEL_FAILURE_FALLBACK_REPLY } from "../server/utils/chat-reply";

/**
 * 模型整轮失败时的兜底话。
 *
 * 背景（2026-11-24 深夜，两次「她没回复」）：模型返回空 content，重试一次仍然空，
 * 整轮被判 `LLM_INVALID_RESPONSE` 丢掉。私聊里没有兜底，用户看到的就是一句都不回 ——
 * 技术上说得通，观感上就是「她不理我」。
 *
 * 这个测试守两件事：
 *   1. 兜底回复对象长得像一条正常回复，但除了正文之外**什么都不许有**；
 *   2. 管道里那条「失败就沉默」的返回被真的换掉了，并且画图/语音/记账都让开了路。
 * 第 2 条只能读源码断言 —— 管道要真跑起来得连库和一个假模型服务，那是隔离库测试的活，
 * 这里守住「别被改回去」这一段。
 */

const fallback = buildModelFailureReply({ reply: MODEL_FAILURE_FALLBACK_REPLY, model: "fixture-model", provider: "example.test" });

assert.equal(fallback.action, "reply", "兜底必须是一条真回复，不能是 silent —— silent 在私聊里就是没声音。");
assert.equal(fallback.reply, MODEL_FAILURE_FALLBACK_REPLY);
assert.ok(MODEL_FAILURE_FALLBACK_REPLY.trim().length > 0, "兜底话不能是空串。");
assert.ok(MODEL_FAILURE_FALLBACK_REPLY.length <= 40, "兜底话要短:长了就成了她在长篇解释一件她自己也不知道的事。");
assert.doesNotMatch(MODEL_FAILURE_FALLBACK_REPLY, /模型|接口|服务器|token|API|错误|报错/u,
  "兜底话不能用技术词:她不该知道、也不该跟用户解释这些。");
assert.doesNotMatch(MODEL_FAILURE_FALLBACK_REPLY, /\n/u, "单句，不换行 —— 换行会被分条发送拆成两条。");

for (const key of ["usedMemoryIds", "usedSnapshotIds", "usedEventIds", "usedRawMessageIds", "faceIds", "usedCatchphraseIds"] as const) {
  assert.deepEqual(fallback[key], [], `兜底里不能带 ${key}:这一轮什么都没发生，带出去就成了下一轮的证据。`);
}
assert.equal(fallback.stickerId, null, "兜底不发表情包。");
assert.equal(fallback.imagePrompt, null, "兜底不带画面描述 —— 带了就会真的去画一张图。");
assert.equal(fallback.imageOffer, null, "兜底不提画图提议。");
assert.equal(fallback.model, "fixture-model");
assert.equal(fallback.provider, "example.test");
assert.match(fallback.promptTemplateVersion, /-v\d+$/u, "模板版本要跟着真实提示词走，不能空着。");

/* ── 管道接线：别把「失败就沉默」改回去 ─────────────────────────────── */

const pipeline = readFileSync(new URL("../server/utils/channel-adapter/pipeline.ts", import.meta.url), "utf8");

assert.match(pipeline, /buildModelFailureReply\(\{ reply: MODEL_FAILURE_FALLBACK_REPLY/u,
  "生成失败的分支里必须真的改发兜底话，而不是继续返回 ignored。");
assert.doesNotMatch(pipeline, /return \{ status: "ignored", reason: \(error instanceof Error \? error\.message : "model_error"\)\.slice\(0, 200\) \};/u,
  "旧的「一律 ignored」已经删掉;群里允许沉默的那条分支要单独判断，见 allowSilent。");
assert.match(pipeline, /if \(allowSilent\) return \{ status: "ignored", reason \};/u,
  "只有『这轮本来就可以不说』的群聊才允许沉默。");
assert.match(pipeline, /imagePlanned && imageSettings && modelFailure/u,
  "模型失败的那轮要跳过画图:不能让兜底话配一张说不清来历的图。");
assert.match(pipeline, /!modelFailure\s*\n?\s*&& voicePlanned/u,
  "兜底话不能走语音条:那句话不是她按说话方式写的。");
assert.match(pipeline, /if \(!modelFailure\) await recordModelUsage\(/u,
  "兜底那一轮 catch 已经记过 failed，不能再补一条 success 把失败盖掉。");
assert.match(pipeline, /"model-failure-fallback"/u,
  "落库 metadata 要标出这条正文是服务端代发的，否则下一轮会被当成她的原话。");
assert.match(pipeline, /modelFailure: \{ reason: modelFailure\.slice\(0, 120\) \}/u,
  "失败原因要留痕(截断保存)，排查「她为什么卡住」只能靠它。");

console.log("Model failure fallback passed: honest short line, rest of the reply left empty, and the channel pipeline no longer goes silent when it owes an answer.");
