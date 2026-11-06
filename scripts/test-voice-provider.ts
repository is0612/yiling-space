/**
 * 语音服务商切换的纯逻辑测试（页面「服务商」下拉的连带填充）。
 *
 * 为什么要单测：这段逻辑出过线上 bug —— Breeze → MiniMax 方向漏了判断，
 * 地址停在 `api.breeze.blue`，界面写着 MiniMax、实际还打 Breeze，合成一律 4xx，
 * 而报错只有一行 HTTP 状态码。三家两两组合六个方向，手点很容易漏。
 */

import assert from "node:assert/strict";

import {
  applyAsrProviderPreset,
  applyVoiceProviderPreset,
  ASR_PRESET,
  looksLikeOtherProvider,
  VOICE_PRESET,
  type VoiceProviderDraft,
} from "../app/utils/voice-provider-preset";

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const minimax = VOICE_PRESET.minimax;
const breeze = VOICE_PRESET.breeze;
const openai = VOICE_PRESET.openai;

check("空配置：选任何一家都填上默认值", () => {
  const empty: VoiceProviderDraft = { baseUrl: "", model: "", voice: "" };
  assert.deepEqual(applyVoiceProviderPreset(empty, "breeze"), breeze);
  assert.deepEqual(applyVoiceProviderPreset(empty, "minimax"), minimax);
  assert.deepEqual(applyVoiceProviderPreset(empty, "openai"), openai);
});

check("Breeze → MiniMax：地址/模型/音色全部换掉（这条是之前的 bug）", () => {
  const next = applyVoiceProviderPreset(breeze, "minimax");
  assert.equal(next!.baseUrl, minimax.baseUrl, "地址必须离开 api.breeze.blue");
  assert.equal(next!.model, minimax.model);
  assert.equal(next!.voice, minimax.voice);
});

check("Breeze → OpenAI 兼容：同样要换", () => {
  const next = applyVoiceProviderPreset(breeze, "openai");
  assert.equal(next!.baseUrl, openai.baseUrl);
  assert.equal(next!.model, openai.model);
  assert.equal(next!.voice, openai.voice);
});

check("MiniMax → Breeze：换成 Breeze 的根地址，音色清空（它没有默认音色）", () => {
  const next = applyVoiceProviderPreset(minimax, "breeze");
  assert.equal(next!.baseUrl, "https://api.breeze.blue");
  assert.equal(next!.model, "breeze-tts-2");
  assert.equal(next!.voice, "", "voc_ id 得用户自己贴，不能塞个假音色");
});

check("OpenAI → Breeze / MiniMax：两个方向都要换", () => {
  assert.equal(applyVoiceProviderPreset(openai, "breeze")!.baseUrl, "https://api.breeze.blue");
  assert.equal(applyVoiceProviderPreset(openai, "minimax")!.baseUrl, "https://api.minimaxi.com/v1");
});

check("MiniMax → OpenAI：换回兼容接口", () => {
  const next = applyVoiceProviderPreset(minimax, "openai");
  assert.equal(next!.baseUrl, openai.baseUrl);
  assert.equal(next!.model, openai.model);
});

check("用户自己的中转地址 / 自定义音色不会被冲掉", () => {
  const custom: VoiceProviderDraft = {
    baseUrl: "https://my-tts-proxy.example.com/v1",
    model: "my-custom-tts",
    voice: "my-voice-id",
  };
  const next = applyVoiceProviderPreset(custom, "minimax");
  assert.deepEqual(next, custom, "认不出来的地址/模型/音色一律保留");
});

check("「自动判断」不动任何字段", () => {
  assert.equal(applyVoiceProviderPreset(minimax, "auto"), null);
  assert.equal(applyVoiceProviderPreset(minimax, ""), null);
  assert.equal(applyVoiceProviderPreset(minimax, "unknown-provider"), null);
});

check("空白值按空处理（用户把输入框清空了再切服务商）", () => {
  const cleared: VoiceProviderDraft = { baseUrl: "   ", model: "", voice: " " };
  const next = applyVoiceProviderPreset(cleared, "breeze");
  assert.equal(next!.baseUrl, breeze.baseUrl);
  assert.equal(next!.model, breeze.model);
});

check("指纹判断本身：别家的默认值认得出来，自己的不认", () => {
  assert.equal(looksLikeOtherProvider("https://api.breeze.blue", "minimax", "url"), true);
  assert.equal(looksLikeOtherProvider("https://api.breeze.blue", "breeze", "url"), false);
  assert.equal(looksLikeOtherProvider("speech-2.5-turbo-preview", "breeze", "model"), true);
  assert.equal(looksLikeOtherProvider("voc_abc", "breeze", "voice"), false);
  assert.equal(looksLikeOtherProvider("https://api.vendor.com/v1", "minimax", "url"), false);
});

check("识别侧选服务商：地址和模型一起带出来", () => {
  assert.deepEqual(
    applyAsrProviderPreset({ baseUrl: "", model: "" }, "minimax"),
    ASR_PRESET.minimax,
    "选 MiniMax 要带出 api.minimaxi.com 和 asr-1.0",
  );
  assert.deepEqual(
    applyAsrProviderPreset({ baseUrl: "", model: "" }, "openai"),
    ASR_PRESET.openai,
  );
});

check("识别侧：合成留下的 Breeze 地址会被换掉，自定义地址保留", () => {
  const fromBreeze = applyAsrProviderPreset(
    { baseUrl: "https://api.breeze.blue", model: "breeze-tts-2" },
    "minimax",
  );
  assert.equal(fromBreeze!.baseUrl, ASR_PRESET.minimax.baseUrl);
  assert.equal(fromBreeze!.model, ASR_PRESET.minimax.model);

  const custom = applyAsrProviderPreset(
    { baseUrl: "https://my-asr-proxy.example.com/v1", model: "my-asr" },
    "minimax",
  );
  assert.equal(custom!.baseUrl, "https://my-asr-proxy.example.com/v1");
});

check("识别侧没有 Breeze 这个选项", () => {
  assert.equal(applyAsrProviderPreset({ baseUrl: "", model: "" }, "breeze"), null);
  assert.equal(applyAsrProviderPreset({ baseUrl: "", model: "" }, "auto"), null);
});

console.log(`\ntest:voice-provider —— ${passed} 项全部通过`);
