/**
 * 「看图」旁路的纯逻辑测试：段解析、占位符回填、配置解析、下载前的地址白名单。
 *
 * 都不联网、不连数据库：真正下载与视觉调用在 test-onebot-adapter.ts 之外，
 * 这两步依赖外部服务，不适合放进每次 verify:local。
 */

import assert from "node:assert/strict";

import {
  applyImageDescriptions,
  assertFetchableImageUrl,
  resolveImageUnderstandingSettings,
  sanitizeDescription,
  MAX_IMAGES_PER_TURN,
} from "../server/utils/image-understanding";
import { readOnebotImages } from "../server/utils/channel-adapter/onebot/types";
import { toCharacterDto } from "../server/utils/character-dto";

// ── 1. 从段数组里取图 ───────────────────────────────────
const images = readOnebotImages({
  message: [
    { type: "text", data: { text: "看这个" } },
    { type: "image", data: { url: "https://multimedia.nt.qq.com.cn/a?rkey=1", file: "A1B2.image", sub_type: 0 } },
    { type: "face", data: { id: "14" } },
    { type: "image", data: { file: "sticker.image", summary: "猫猫" } },
  ],
});
assert.equal(images.length, 2, "只挑 image 段。");
assert.equal(images[0]!.url, "https://multimedia.nt.qq.com.cn/a?rkey=1");
assert.equal(images[0]!.file, "A1B2.image");
assert.equal(images[1]!.url, "", "表情包没有 url —— 不能拿 file 当路径去读。");
assert.equal(images[1]!.summary, "猫猫");

// 纯文本消息（CQ 字符串形态）里没有图。
assert.deepEqual(readOnebotImages({ message: "你好" }), []);
assert.deepEqual(readOnebotImages({}), []);

// ── 2. 描述回填 ────────────────────────────────────────
assert.equal(
  applyImageDescriptions("看图[图片]好不好", ["只橘猫趴在键盘上"]),
  "看图[图片：只橘猫趴在键盘上]好不好",
);
// 多张图按顺序填；失败的位置保持原样。
assert.equal(
  applyImageDescriptions("[图片][图片]", ["第一张：猫", null]),
  "[图片：第一张：猫][图片]",
);
// 描述里本身带 [图片] 时不能重复替换（游标的作用）。
assert.equal(
  applyImageDescriptions("[图片] 和 [图片]", ["图里写着[图片]两个字", "第二张"]),
  "[图片：图里写着[图片]两个字] 和 [图片：第二张]",
);
// 没有占位符就不动它。
assert.equal(applyImageDescriptions("纯文字", ["描述"]), "纯文字");

// ── 3. 描述清洗 ────────────────────────────────────────
assert.equal(sanitizeDescription("  一只猫\n\n在键盘上  "), "一只猫 在键盘上");
assert.equal(sanitizeDescription("   "), null);
assert.equal(sanitizeDescription("字".repeat(1000))!.length, 400, "描述进提示词，必须限长。");

// ── 4. 配置解析 ────────────────────────────────────────
const savedEnv = {
  VISION_MODEL: process.env.VISION_MODEL,
  VISION_BASE_URL: process.env.VISION_BASE_URL,
  VISION_API_KEY: process.env.VISION_API_KEY,
};
function clearVisionEnv() {
  delete process.env.VISION_MODEL;
  delete process.env.VISION_BASE_URL;
  delete process.env.VISION_API_KEY;
}
try {
  const enabled = { imageUnderstanding: true };

  // 默认关闭：角色没打开开关就什么都不做，群里的图仍然只是 [图片] ——
  // 哪怕这台机器已经配了 VISION_MODEL，也不能悄悄开始花钱。
  clearVisionEnv();
  process.env.VISION_MODEL = "qwen-vl-max";
  assert.equal(
    resolveImageUnderstandingSettings({
      modelConfig: {},
      chatModel: "deepseek-flash",
      chatApiBaseUrl: "https://api.example.com/v1",
      chatApiKey: "k",
    }),
    null,
    "开关没打开时不看图。",
  );
  clearVisionEnv();

  // 打开开关、没有单独配视觉模型：回落到这个角色自己的聊天模型（实测 flash/gpt-4o-mini 都能读图）。
  assert.deepEqual(
    resolveImageUnderstandingSettings({
      modelConfig: enabled,
      chatModel: "deepseek-flash",
      chatApiBaseUrl: "https://api.deepseek.com/",
      chatApiKey: "k",
    }),
    { model: "deepseek-flash", apiBaseUrl: "https://api.deepseek.com", apiKey: "k" },
    "没配 VISION_MODEL 时用角色自己的模型，不用再准备第二份凭据。",
  );

  // 环境变量优先于聊天模型：想统一换一个更便宜/更快的视觉模型时不用改每个角色。
  process.env.VISION_MODEL = "qwen-vl-max";
  assert.equal(
    resolveImageUnderstandingSettings({
      modelConfig: enabled,
      chatModel: "deepseek-flash",
      chatApiBaseUrl: "https://api.example.com/v1",
      chatApiKey: "k",
    })?.model,
    "qwen-vl-max",
  );
  clearVisionEnv();

  // 显式关闭：全局配了视觉模型也照样不看。
  assert.equal(
    resolveImageUnderstandingSettings({
      modelConfig: { imageUnderstanding: false },
      chatModel: "gpt-4o-mini",
      chatApiBaseUrl: "https://api.example.com/v1",
      chatApiKey: "k",
    }),
    null,
  );

  // 角色级覆盖模型与地址（数据驱动：不把服务商写死在代码里）。
  assert.deepEqual(
    resolveImageUnderstandingSettings({
      modelConfig: { imageUnderstanding: true, visionModel: "glm-4v", visionApiBaseUrl: "https://open.bigmodel.cn/api/paas/v4" },
      chatModel: "deepseek-flash",
      chatApiBaseUrl: "https://api.example.com/v1",
      chatApiKey: "k",
    }),
    { model: "glm-4v", apiBaseUrl: "https://open.bigmodel.cn/api/paas/v4", apiKey: "k" },
  );

  // 地址写错就当没开，而不是让群聊整轮失败。
  assert.equal(
    resolveImageUnderstandingSettings({
      modelConfig: { imageUnderstanding: true, visionApiBaseUrl: "不是地址" },
      chatModel: "deepseek-flash",
      chatApiBaseUrl: "https://api.example.com/v1",
      chatApiKey: "k",
    }),
    null,
  );

  // 没有 Key 也不做（避免拿着空 Key 打一圈 401）。
  assert.equal(
    resolveImageUnderstandingSettings({
      modelConfig: enabled,
      chatModel: "deepseek-flash",
      chatApiBaseUrl: "https://api.example.com/v1",
      chatApiKey: "",
    }),
    null,
  );
} finally {
  clearVisionEnv();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value !== undefined) process.env[key] = value;
  }
}

// ── 5. DTO 要把开关带给前端（否则页面上那个 switch 永远显示关）──
const dtoBase = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "测试角色",
  avatar: null,
  basePrompt: "人设",
  styleExamples: "",
  userAddress: "主人",
  status: "ACTIVE" as const,
  updatedAt: new Date("2026-10-29T00:00:00Z"),
  memorySetting: null,
  channelBindings: [],
  memoryScopes: [],
};
assert.equal(
  toCharacterDto({ ...dtoBase, modelConfig: { imageUnderstanding: true } }).imageUnderstanding,
  true,
);
assert.equal(
  toCharacterDto({ ...dtoBase, modelConfig: {} }).imageUnderstanding,
  false,
  "没存过这个字段时必须当作关。",
);

// ── 6. 下载前的地址白名单（SSRF）──────────────────────
assert.equal(
  assertFetchableImageUrl("https://multimedia.nt.qq.com.cn/download?rkey=x").hostname,
  "multimedia.nt.qq.com.cn",
);
for (const blocked of [
  "file:///C:/Windows/win.ini",
  "http://127.0.0.1:8080/a.png",
  "http://localhost/a.png",
  "http://10.0.0.5/a.png",
  "http://192.168.1.2/a.png",
  "http://169.254.169.254/latest/meta-data",
  "https://[::1]/a.png",
  "http://printer.local/a.png",
]) {
  assert.throws(() => assertFetchableImageUrl(blocked), /IMAGE_/, `必须拒绝：${blocked}`);
}
// 带上账号密码的 URL 也拒绝：那是把凭据塞进日志的常见姿势。
assert.throws(() => assertFetchableImageUrl("https://user:pass@example.com/a.png"), /IMAGE_/);

assert.equal(MAX_IMAGES_PER_TURN, 3, "一轮最多看三张，别让一次群聊刷出一堆视觉调用。");

console.log("test-image-understanding: ok");
