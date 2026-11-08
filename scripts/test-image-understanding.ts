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
  shrinkForVision,
  VISION_MAX_EDGE,
  MAX_IMAGES_PER_TURN,
} from "../server/utils/image-understanding";
import { readOnebotImages } from "../server/utils/channel-adapter/onebot/types";
import { toCharacterDto } from "../server/utils/character-dto";
import {
  describeImageGenerationModel,
  isImageGenerationModel,
} from "../shared/utils/vision-models";

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
// 多张图按顺序填；失败的位置明确标记为无法读取。
assert.equal(
  applyImageDescriptions("[图片][图片]", ["第一张：猫", null]),
  "[图片：第一张：猫][图片：无法读取]",
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
  // 单独配的视觉 Key 优先于聊天那把：换一家服务商时，绝不能拿聊天的 Key 打过去（必然 401）。
  assert.deepEqual(
    resolveImageUnderstandingSettings({
      modelConfig: {
        imageUnderstanding: true,
        visionModel: "glm-4.6v-flash",
        visionApiBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
      },
      chatModel: "deepseek-flash",
      chatApiBaseUrl: "https://api.deepseek.com",
      chatApiKey: "deepseek-key",
      visionApiKey: "zhipu-key",
    }),
    { model: "glm-4.6v-flash", apiBaseUrl: "https://open.bigmodel.cn/api/paas/v4", apiKey: "zhipu-key" },
    "角色单独配的视觉 Key 要盖过聊天 Key。",
  );

  // 环境变量那把 Key 排在「角色 Key」之后、「聊天 Key」之前。
  process.env.VISION_API_KEY = "env-vision-key";
  assert.equal(
    resolveImageUnderstandingSettings({
      modelConfig: enabled,
      chatModel: "deepseek-flash",
      chatApiBaseUrl: "https://api.example.com/v1",
      chatApiKey: "chat-key",
    })?.apiKey,
    "env-vision-key",
  );
  clearVisionEnv();

  // 「测试看图」要能在开关还没打开时验证模型通不通 —— 否则用户得先去 QQ 那边点开关，
  // 再回来猜刚才那次失败是配置问题还是没生效。
  assert.equal(
    resolveImageUnderstandingSettings({
      modelConfig: { visionModel: "glm-4.6v-flash", visionApiBaseUrl: "https://open.bigmodel.cn/api/paas/v4" },
      chatModel: "deepseek-flash",
      chatApiBaseUrl: "https://api.deepseek.com",
      chatApiKey: "k",
      visionApiKey: "zhipu-key",
    }, { requireSwitch: false })?.model,
    "glm-4.6v-flash",
    "测试看图不看开关。",
  );
  // 但那条豁免只属于测试入口：默认仍然是「没开关就不看图」。
  assert.equal(
    resolveImageUnderstandingSettings({
      modelConfig: { visionModel: "glm-4.6v-flash" },
      chatModel: "deepseek-flash",
      chatApiBaseUrl: "https://api.example.com/v1",
      chatApiKey: "k",
    }),
    null,
    "默认行为不变：开关没打开就不看图。",
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

// ── 7. 失败项必须吃掉占位符（第二轮复现：描述错位）──────────
/**
 * 契约（本轮新增，生产实现尚未满足）：一张图识别失败时，它那个坑要填成
 * `[图片：无法读取]`，**不能**让后面那张的描述往前顶。
 *
 * 当前 `applyImageDescriptions` 里 null 走的是 `continue`，没消费占位符：
 * `[图片][图片]` + `[null, "第二张"]` 会得到 `[图片：第二张][图片]` ——
 * 第二张的描述被安到了第一张头上。语音那边（`applyVoiceTranscripts`）是消费的、
 * 填 `[语音（没转成文字）]`，两边行为不一致，说明这是漏了而不是设计取舍。
 */
const IMAGE_UNREADABLE = "[图片：无法读取]";
const placeholderFailures: string[] = [];

function expectText(name: string, actual: string, expected: string) {
  if (actual === expected) {
    console.log(`  PASS ${name}`);
    return;
  }
  placeholderFailures.push(`${name}：期望 ${expected}，实际 ${actual}`);
  console.log(`  FAIL ${name}\n       期望：${expected}\n       实际：${actual}`);
}

// 7.1 首位失败：第二张的描述绝不能顶到第一张的坑里。
expectText(
  "首位识别失败不错位",
  applyImageDescriptions("[图片][图片]", [null, "第二张图片的描述"]),
  `${IMAGE_UNREADABLE}[图片：第二张图片的描述]`,
);
// 7.2 反向场景：首位成功、次位失败。
expectText(
  "末位识别失败不错位",
  applyImageDescriptions("[图片][图片]", ["第一张图片的描述", null]),
  `[图片：第一张图片的描述]${IMAGE_UNREADABLE}`,
);
// 7.3 中间失败：三张图里第二张挂了，第一、第三张各自留在原位。
expectText(
  "中间识别失败不错位",
  applyImageDescriptions("[图片][图片][图片]", ["第一张", null, "第三张"]),
  `[图片：第一张]${IMAGE_UNREADABLE}[图片：第三张]`,
);
// 7.4 连续失败：两个坑都要占住，不能退化成裸的 [图片]。
expectText(
  "连续识别失败逐个占位",
  applyImageDescriptions("[图片][图片]", [null, null]),
  `${IMAGE_UNREADABLE}${IMAGE_UNREADABLE}`,
);
// 7.5 全成功：位置必须原样保持（防回归）。
expectText(
  "全部成功时按序填充",
  applyImageDescriptions("[图片] 和 [图片]", ["第一张", "第二张"]),
  "[图片：第一张] 和 [图片：第二张]",
);

assert.equal(
  placeholderFailures.length,
  0,
  `图片描述占位契约未满足（${placeholderFailures.length} 条）：\n- ${placeholderFailures.join("\n- ")}`,
);

assert.equal(MAX_IMAGES_PER_TURN, 3, "一轮最多看三张，别让一次群聊刷出一堆视觉调用。");

// ── 送进视觉模型前的缩图 ───────────────────────────────
// 大图 base64 常常 2~4MB，视觉接口直接回 400；缩到 1024 边长能消掉这类失败。
{
  const sharp = (await import("sharp")).default;

  const big = await sharp({
    create: { width: 3000, height: 2000, channels: 3, background: { r: 20, g: 120, b: 200 } },
  }).png().toBuffer();
  const shrunk = await shrinkForVision({ buffer: big, mime: "image/png" });
  const shrunkMeta = await sharp(shrunk.buffer).metadata();
  assert.ok(
    Math.max(shrunkMeta.width ?? 0, shrunkMeta.height ?? 0) <= VISION_MAX_EDGE,
    `大图应该缩到 ${VISION_MAX_EDGE} 以内，实际 ${shrunkMeta.width}x${shrunkMeta.height}`,
  );
  assert.equal(shrunk.mime, "image/jpeg", "缩过之后统一转 jpeg，体积最小");
  assert.ok(shrunk.buffer.length < big.length, "缩完必须比原图小");

  const small = await sharp({
    create: { width: 640, height: 480, channels: 3, background: { r: 200, g: 60, b: 60 } },
  }).png().toBuffer();
  const untouched = await shrinkForVision({ buffer: small, mime: "image/png" });
  assert.equal(untouched.buffer, small, "本来就不大就原样返回，不做无谓的重编码");

  const broken = Buffer.from("not an image");
  const fallback = await shrinkForVision({ buffer: broken, mime: "image/png" });
  assert.equal(fallback.buffer, broken, "解不开的图原样送出去，让服务商自己报错");
}

// ── 生图模型 vs 看图模型的名字判据 ─────────────────────
// 2026-11-08 实况：中转的 `/models` 里 `gpt-image-2` 排第一位，用户按「看图」的直觉选中它，
// 测试看图回 404（upstream rejected the request: not found）—— 看起来像 Base URL 填错了。
// 这个判据只用来提前提醒：命中的标灰 + 404 时换一句话说清「它是画图的，不是看图的」。
{
  // 命中：这些名字都属于「生成图片」，不在 chat/completions 上
  for (const model of [
    "gpt-image-2",
    "gpt-image-1",
    "openai/gpt-image-1",
    "dall-e-3",
    "dalle-3",
    "imagen-3.0",
    "flux-1.1-pro",
    "stable-diffusion-3",
    "sdxl",
    "sd3-medium",
    "seedream-3.0",
    "wanx2.1-t2i",
    "qwen-image",
    "cogview-4",
    "midjourney",
    "kling-v2",
  ]) {
    assert.equal(isImageGenerationModel(model), true, `${model} 应该被判成生图模型`);
  }

  // 放行：真的能读图的对话模型，以及认不出来的新名字（宁可不提醒，也别标灰）
  for (const model of [
    "gpt-4o",
    "gpt-4o-mini",
    "gpt-4.1-mini",
    "glm-4.6v-flash",
    "glm-4v-flash",
    "qwen3-vl-flash",
    "hunyuan-vision",
    "gpt-5.6-luna",
    "deepseek-flash",
    "some-future-model-7",
    "",
    "   ",
  ]) {
    assert.equal(isImageGenerationModel(model), false, `${model || "(空)"} 不该被判成生图模型`);
  }

  assert.ok(isImageGenerationModel("  GPT-Image-2  "), "大小写与空白不该影响判据");

  const message = describeImageGenerationModel("gpt-image-2");
  assert.ok(message.includes("gpt-image-2"), "提示里要带上是哪个模型名");
  assert.ok(message.includes("404") && message.includes("400"), "服务商可能回 404 也可能回 400，别只写一个");
  assert.ok(message.includes("对话模型"), "要给出下一步：换一个能读图的对话模型");
}

console.log("test-image-understanding: ok");
