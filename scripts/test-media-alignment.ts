/**
 * QQ 媒体段位映射回归测试。
 *
 * 覆盖「前面的媒体没有 URL，后面的媒体有 URL」时的原始序号回填，
 * 以及 voice 段的正文占位符。全程不访问网络、数据库或模型。
 *
 * 跑法：npx tsx scripts/test-media-alignment.ts
 */
import assert from "node:assert/strict";

import { alignMediaResults } from "../server/utils/media-result-alignment";
import { applyImageDescriptions } from "../server/utils/image-understanding";
import { applyVoiceTranscripts, VOICE_UNTRANSCRIBED } from "../server/utils/voice";
import { readOnebotMessageText, readOnebotVoices } from "../server/utils/channel-adapter/onebot/types";

const imageDescriptions = alignMediaResults(2, [1], ["第二张图片"]);
assert.deepEqual(imageDescriptions, [null, "第二张图片"]);
assert.equal(
  applyImageDescriptions("[图片][图片]", imageDescriptions),
  "[图片：无法读取][图片：第二张图片]",
  "第一张图片没有 URL 时，第二张描述不能错填到第一张。",
);

const noImageUrls = alignMediaResults(2, [], [], null);
assert.deepEqual(noImageUrls, [null, null]);
assert.equal(
  applyImageDescriptions("[图片][图片]", noImageUrls),
  "[图片：无法读取][图片：无法读取]",
  "一条消息全部图片都没有直链时，每个槽位都应明确标为无法读取。",
);

const voiceTranscripts = alignMediaResults(2, [1], ["第二条语音"]);
assert.deepEqual(voiceTranscripts, [null, "第二条语音"]);
assert.equal(
  applyVoiceTranscripts("[语音][语音]", voiceTranscripts),
  `${VOICE_UNTRANSCRIBED}[语音：第二条语音]`,
  "第一条语音没有 URL 时，第二条转写不能错填到第一条。",
);

assert.deepEqual(
  alignMediaResults(3, [0, 2], ["第一张", null]),
  ["第一张", null, null],
  "中间没有 URL 或识别失败的槽位都必须留在原位置。",
);
assert.deepEqual(
  alignMediaResults(3, [2], ["第三张"]),
  [null, null, "第三张"],
  "前面多个媒体缺失时仍按原序号回填。",
);

const imageLimitResults = alignMediaResults(3, [0], ["第一张"], undefined);
assert.deepEqual(imageLimitResults, ["第一张", undefined, undefined]);
assert.equal(
  applyImageDescriptions("[图片][图片][图片]", imageLimitResults),
  "[图片：第一张][图片][图片]",
  "因单轮图片上限未处理的图片继续保留原占位符。",
);

const voiceLimitResults = alignMediaResults(3, [0], ["第一条"], undefined);
assert.deepEqual(voiceLimitResults, ["第一条", undefined, undefined]);
assert.equal(
  applyVoiceTranscripts("[语音][语音][语音]", voiceLimitResults),
  "[语音：第一条][语音][语音]",
  "因单轮 ASR 上限未处理的语音继续保留原占位符。",
);

const voiceEvent = {
  message: [
    { type: "text", data: { text: "你听这个" } },
    { type: "voice", data: { url: "https://media.example.test/voice.silk", file: "voice.silk" } },
  ],
};
assert.equal(readOnebotMessageText(voiceEvent), "你听这个[语音]");
assert.equal(readOnebotVoices(voiceEvent).length, 1, "voice 段必须进入语音识别媒体列表。");

const recordEvent = {
  message: [
    { type: "text", data: { text: "再听这个" } },
    { type: "record", data: { url: "https://media.example.test/record.silk" } },
  ],
};
assert.equal(readOnebotMessageText(recordEvent), "再听这个[语音]");
assert.equal(readOnebotVoices(recordEvent).length, 1, "record 标准段行为继续保留。");

console.log("test-media-alignment: PASS");
