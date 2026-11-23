/**
 * 画图（文生图）链路的纯逻辑测试：判定、规划、配置解析、响应解析、落库痕迹。
 *
 * 都不联网：真调生图接口要服务商凭据，而且要花钱，不可能进每次 verify:local。
 * 这里守的是**判据**——哪些话算让她画、什么情况下不画、什么响应算一张图。
 */

import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { imageSizeOptions, resolveImagePixels } from "../shared/utils/image-size";
import { LOCAL_IMAGE_MODELS } from "../shared/utils/local-image-engine";
import { cleanTagLine, needsTagTranslation, parseTagTranslation } from "../server/utils/image-prompt-translation";
import { dirname } from "node:path";

import {
  DEFAULT_IMAGE_DAILY_LIMIT,
  DEFAULT_IMAGE_MODEL,
  DEFAULT_MINIMAX_IMAGE_BASE,
  generateImage,
  IMAGE_SIZE_PRESETS,
  isImageGenerationEnabled,
  isImageRequested,
  isImageGenerationDeclined,
  readImageExecutionState,
  parseImageResponse,
  planImageReply,
  promptFromRequest,
  readStoredImageFlag,
  readSentImageFlag,
  readStoredImageMeta,
  resolveImageChance,
  resolveImageCooldownMinutes,
  resolveImageDailyLimit,
  resolveImageGenerationSettings,
  resolveImageSizePreset,
  sanitizeImagePrompt,
  toAnimaPromptParts,
} from "../server/utils/image-generation";
import { toCharacterDto } from "../server/utils/character-dto";
import {
  encryptApiKey,
  isImageApiKeySaved,
  resolveCharacterImageApiKey,
} from "../server/utils/credential-encryption";

/**
 * 本机的 `.env` 可能已经配了 IMAGE_*，那些值会让「没配就没有」这类断言假失败。
 * 先把它们摘掉，结束时原样放回。
 */
const ENV_KEYS = ["IMAGE_MODEL", "IMAGE_BASE_URL", "IMAGE_API_KEY", "IMAGE_PROVIDER", "COMFYUI_BASE_URL"] as const;
const savedEnv = new Map<string, string | undefined>();
for (const key of ENV_KEYS) {
  savedEnv.set(key, process.env[key]);
  delete process.env[key];
}
function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

// ── 1. 哪些话算「让她画」 ───────────────────────────────
const positive = [
  "画一只橘猫趴在窗台上",
  "画张图呗",
  "帮我画个头像",
  "给我画一幅下雪的街道",
  "来张图，要赛博朋克风",
  "出张图看看",
  "生成一张海报",
  "整张画，越怪越好",
  "能不能画个柴犬",
  "你能画一只猫吗？",
  // 2026-11-22：用户连发两句「再画一次试试」，一句都没算下单，她只顾着答「画好了」。
  // 「次 / 回 / 遍」是动作量词，和「张 / 只」不是一类，但语义一样强，必须单列一条判据。
  "再画一次试试",
  "再画一次",
  "画一遍看看",
  "画几回",
  // 短到只剩命令词的时候也要认：催第二次的人往往就这么说
  "再画",
  "画一下",
  "画吧",
  "画",
];
for (const text of positive) {
  assert.equal(isImageRequested(text), true, `应当识别为画图请求：${text}`);
}

const negative = [
  "画重点，明天考这三章",
  "你画得真好",
  "这也太漫画了吧",
  "我们一起规划一下周末",
  "你会画图吗",
  "讨论画画",
  "画画的尽头是猎奇",
  "只是给她加个画画功能",
  "她看不到自己画的图",
  "我给你画个头像",
  "他让她画猫",
  "你画这个的提示词是啥",
  "这个画风我不喜欢",
  "别画了，聊点别的",
  "别再画了",
  "不用画了",
  "不必画了",
  "画饼谁不会",
  "",
];
for (const text of negative) {
  assert.equal(isImageRequested(text), false, `不该识别为画图请求：${text}`);
}
/**
 * 否定词只否定紧跟着的那个动词。
 * 「别管我，你画一个」里「别」管的是「管我」—— 判成不要画，就是该画的时候哑火，
 * 而且用户完全看不出原因（比多画一张糟得多）。
 */
assert.equal(isImageRequested("别管我，你画一个"), true, "否定词不该跨词生效。");
assert.equal(isImageRequested("画好了吗"), false, "问进度不是下单。");

// ── 2. 开关 / 概率 / 冷却 / 每日上限 ────────────────────
assert.equal(isImageGenerationEnabled({}), false, "默认关。");
assert.equal(isImageGenerationEnabled({ imageEnabled: true }), true);
assert.equal(isImageGenerationEnabled({ imageEnabled: "true" }), false, "只认布尔 true。");

assert.equal(resolveImageChance({}), 5, "默认自主概率 5%。");
assert.equal(resolveImageChance({ imageChance: 0 }), 0);
assert.equal(resolveImageChance({ imageChance: 500 }), 100, "越界夹到 100。");
assert.equal(resolveImageChance({ imageChance: -3 }), 0);

assert.equal(resolveImageCooldownMinutes({}), 30, "默认 30 分钟。");
assert.equal(resolveImageCooldownMinutes({ imageCooldownMinutes: 0 }), 0);
assert.equal(resolveImageCooldownMinutes({ imageCooldownMinutes: 99999 }), 1440, "上限一天。");

assert.equal(resolveImageDailyLimit({}), DEFAULT_IMAGE_DAILY_LIMIT);
assert.equal(resolveImageDailyLimit({ imageDailyLimit: 0 }), 0, "0 = 不限。");
assert.equal(resolveImageDailyLimit({ imageDailyLimit: 999 }), 200, "上限 200。");

assert.equal(resolveImageSizePreset({}), "square");
assert.equal(resolveImageSizePreset({ imageSize: "portrait" }), "portrait");
assert.equal(resolveImageSizePreset({ imageSize: "乱填的" }), "square", "写错当方图。");

const on = { imageEnabled: true, imageChance: 100, imageCooldownMinutes: 30, imageDailyLimit: 8 };
const now = new Date("2026-11-22T12:00:00+08:00");

assert.equal(planImageReply({ modelConfig: on, random: () => 0.99 }), true, "概率 100 时抽中。");
assert.equal(planImageReply({ modelConfig: { ...on, imageChance: 0 }, random: () => 0 }), false, "概率 0 不自主动画。");
assert.equal(planImageReply({ modelConfig: { ...on, imageChance: 0 }, force: true }), true, "被明确要求时跳过概率。");
assert.equal(
  planImageReply({
    modelConfig: on,
    lastImageAt: new Date("2026-11-22T11:50:00+08:00"),
    now,
    random: () => 0,
  }),
  false,
  "冷却未过时不自主画。",
);
assert.equal(
  planImageReply({
    modelConfig: on,
    lastImageAt: new Date("2026-11-22T11:50:00+08:00"),
    now,
    force: true,
  }),
  true,
  "被要求时冷却不生效。",
);
assert.equal(
  planImageReply({ modelConfig: { ...on, imageCooldownMinutes: 0 }, lastImageAt: new Date("2026-11-22T11:59:00+08:00"), now, random: () => 0 }),
  true,
  "冷却填 0 = 不冷却。",
);
assert.equal(
  planImageReply({ modelConfig: on, todayCount: 8, now, force: true }),
  false,
  "每日上限对「被要求」也生效。",
);
assert.equal(
  planImageReply({ modelConfig: { ...on, imageDailyLimit: 0 }, todayCount: 999, now, force: true }),
  true,
  "上限 0 = 不限。",
);
assert.equal(planImageReply({ modelConfig: { imageEnabled: false }, force: true }), false, "开关关着时谁要求都不画。");

// ── 3. 画面描述清洗 ────────────────────────────────────
assert.equal(
  sanitizeImagePrompt("主体：橘猫\n风格：胶片\n光线：午后暖光"),
  "主体：橘猫，风格：胶片，光线：午后暖光",
  "换行压成逗号。",
);
assert.equal(sanitizeImagePrompt("   \n  "), "");
assert.ok(sanitizeImagePrompt("猫".repeat(5000)).length <= 1200, "长度有上限。");

assert.equal(promptFromRequest("帮我画一只橘猫"), "一只橘猫", "只去掉请求的语法，保留宾语的量词。");
assert.equal(promptFromRequest("画一张下雨的街道"), "下雨的街道");
assert.equal(promptFromRequest("画个猫"), "猫");
assert.equal(promptFromRequest("再画个苹果"), "苹果", "「再」是催办词，不是画面内容。");
assert.equal(promptFromRequest("来张图"), "", "没有画面宾语时不可用整句聊天兜底。");

// ── 4. 配置解析：页面 > 环境变量 > 默认 ─────────────────
// Key 走第二个参数（和语音同一个约定：由解密层读出来再传进来，
// 函数本身不直接读 modelConfig.imageApiKey —— 那样会绕过明文/旧密文的兼容读取）。
assert.equal(
  resolveImageGenerationSettings({ modelConfig: {} }),
  null,
  "没有 Key 就不启用（默认状态）。",
);

const withKey = resolveImageGenerationSettings({ modelConfig: {}, imageApiKey: "sk-page" });
assert.ok(withKey, "填了 Key 就能用。");
assert.equal(withKey!.model, DEFAULT_IMAGE_MODEL, "默认 MiniMax-H3-Image。");
assert.equal(withKey!.apiBaseUrl, DEFAULT_MINIMAX_IMAGE_BASE, "默认 minimaxi 域名。");
assert.equal(withKey!.size, IMAGE_SIZE_PRESETS.square);

const overridden = resolveImageGenerationSettings({
  modelConfig: {
    imageModel: "MiniMax-H3-Image-Highspeed",
    imageApiBaseUrl: "https://api.minimax.cn/v1",
    imageSize: "portrait",
    imageProvider: "minimax",
  },
  imageApiKey: "sk-page",
});
assert.equal(overridden!.model, "MiniMax-H3-Image-Highspeed");
assert.equal(overridden!.apiBaseUrl, "https://api.minimax.cn/v1");
assert.equal(overridden!.size, IMAGE_SIZE_PRESETS.portrait);

// ---- 尺寸档位随服务商与模型变化 -------------------------------------------------
assert.equal(resolveImagePixels("minimax", "MiniMax-H3-Image", "portrait"), "864x1152");
assert.equal(resolveImagePixels("openai", "gpt-image-1", "portrait"), "1024x1536", "gpt-image-1 不认 864×1152");
assert.equal(resolveImagePixels("openai", "dall-e-3", "landscape"), "1792x1024");
assert.equal(resolveImagePixels("openai", "dall-e-2", "portrait"), "1024x1024", "dall-e-2 只有方图，降级而不是报错");
assert.equal(resolveImagePixels("custom", "some-model", "square"), "1024x1024");
assert.equal(resolveImagePixels("openai", "gpt-image-2.5-sunburst", "portrait"), "1024x1536", "2.5 两个变体与 1 同尺寸");
assert.equal(resolveImagePixels("openai", "gpt-image-2.5-flare", "landscape"), "1536x1024");
assert.equal(imageSizeOptions("minimax", "").length, 3);
assert.equal(imageSizeOptions("openai", "dall-e-2").length, 1, "不可用的档位不该出现在选项里");
assert.ok(imageSizeOptions("openai", "gpt-image-1").every(option => /（\d+ × \d+）$/u.test(option.label)), "选项要带实际像素");

const openAiPortrait = resolveImageGenerationSettings({
  modelConfig: {
    imageModel: "gpt-image-1",
    imageApiBaseUrl: "https://api.openai.com/v1",
    imageSize: "portrait",
    imageProvider: "openai",
  },
  imageApiKey: "sk-openai",
});
assert.equal(openAiPortrait!.size, "1024x1536", "同一档位换个服务商就是另一组像素");

// ---- 本机引擎（ComfyUI + Anima）--------------------------------------------
// 和云端最大的差别：**不需要 Key**。ComfyUI 根本没有鉴权，要求填 Key 等于永远画不了。
const localDefault = resolveImageGenerationSettings({ modelConfig: { imageProvider: "comfyui" } });
assert.ok(localDefault, "本地引擎不需要 Key。");
assert.equal(localDefault!.apiBaseUrl, "http://127.0.0.1:8188", "默认就是 ComfyUI 的端口。");
assert.equal(localDefault!.apiKey, "");
assert.equal(localDefault!.model, "anima-turbo-v1.1.safetensors", "默认快速档 = Turbo。");
assert.equal(localDefault!.quality, "fast");
assert.equal(localDefault!.size, "1024x1024");

const localQuality = resolveImageGenerationSettings({
  modelConfig: { imageProvider: "comfyui", imageQuality: "quality", imageSize: "portrait" },
});
assert.equal(localQuality!.model, "anima-aesthetic-v1.1.safetensors", "精修档自动换成 Aesthetic。");
assert.equal(localQuality!.quality, "quality");
assert.equal(localQuality!.size, "896x1152", "8G 显存别给 1536 那一档。");

// 只填了 8188 地址、没选服务商：也该认成本地引擎，而不是猜成 OpenAI 再 401。
const localByUrl = resolveImageGenerationSettings({ modelConfig: { imageApiBaseUrl: "http://127.0.0.1:8188" } });
assert.equal(localByUrl!.provider, "comfyui", "8188 是 ComfyUI，不该让用户先去选服务商。");

// 显式选了本地：局域网里另一台机器上的 ComfyUI 也要能填（云端那套校验会拒绝私有地址）。
const localLan = resolveImageGenerationSettings({
  modelConfig: { imageProvider: "comfyui", imageApiBaseUrl: "http://192.168.1.20:8188" },
});
assert.equal(localLan!.apiBaseUrl, "http://192.168.1.20:8188");
assert.equal(
  resolveImageGenerationSettings({ modelConfig: { imageProvider: "comfyui", imageApiBaseUrl: "ftp://127.0.0.1:8188" } }),
  null,
  "协议不对当没开，不抛。",
);

// ---- 分段提示词 → Anima 的正/负两半 ------------------------------------------
// 云端模型读得懂【人物】【画面】这些中文标签，Anima 一个都不认识。
// 不拆开会把整段中文说明当成画面内容，出来就是一张无关的图。
{
  const parts = toAnimaPromptParts(
    "【人物】blue hair, red eyes；【造型·女仆装】maid outfit；"
    + "【参考图】图1 标准形象——只用来确定长相：脸型五官、发型发色；参考图里的服装、姿势、表情都不要照搬，构图按【画面】重新安排；"
    + "【画面】1girl, standing in snow, upper body；【避免】extra fingers, bad anatomy",
  );
  assert.equal(parts.positive, "blue hair, red eyes, maid outfit, 1girl, standing in snow, upper body");
  assert.equal(parts.negative, "extra fingers, bad anatomy", "【避免】要变成负面提示词，不能留在正向里当内容。");
  assert.ok(!/参考图|只用来确定长相|重新安排/u.test(parts.positive), "中文指令段（含它内部的分号和【画面】）必须整段丢掉。");
}
assert.deepEqual(
  toAnimaPromptParts("1girl, solo, rainy street at night"),
  { positive: "1girl, solo, rainy street at night", negative: "" },
  "没有分段标签时原样使用。",
);

// ---- 中文 → 英文标签：拆出来的两半先交给它翻 -----------------------------------
// 这一段守的是「她会自己转英文」：翻的是**角色自己的聊天模型**，不是查表。
assert.equal(needsTagTranslation("1girl, solo, blue hair"), false);
assert.equal(needsTagTranslation("蓝紫色长发，蓝色眼睛"), true);

assert.equal(cleanTagLine("POSITIVE: 1girl, blue hair"), "1girl, blue hair", "标签前缀要摘掉。");
assert.equal(cleanTagLine("```\n1girl, solo\n```"), "1girl, solo", "代码围栏要摘掉。");
assert.equal(cleanTagLine("1girl，蓝发"), null, "带中文就整行作废 —— 塞进 CLIP 只是噪声。");
assert.equal(cleanTagLine('"1girl"'), "1girl", "模型爱加引号。");
assert.equal(cleanTagLine("   "), null);

const translation = parseTagTranslation("POSITIVE: 1girl, long blue hair, white dress\nNEGATIVE: extra fingers");
assert.deepEqual(translation, { positive: "1girl, long blue hair, white dress", negative: "extra fingers" });
assert.deepEqual(parseTagTranslation("1girl, solo, snow"), { positive: "1girl, solo, snow", negative: "" }, "没前缀也认，正向照用。");
assert.equal(parseTagTranslation("NEGATIVE: bad anatomy"), null, "没有正向就不算成功。");
// 模型不肯按两行协议写时的三种常见形状：以前一律判废，中文直接进 CLIP。
assert.deepEqual(
  parseTagTranslation('好的，这是结果：\n```json\n{"positive": "1girl, blue hair", "negative": "bad anatomy"}\n```'),
  { positive: "1girl, blue hair", negative: "bad anatomy" },
  "JSON 对象带围栏和废话也要认。",
);
assert.deepEqual(
  parseTagTranslation("翻译结果：\n- 正向提示词：1girl, whale girl, white shirt\n- 负面：extra fingers"),
  { positive: "1girl, whale girl, white shirt", negative: "extra fingers" },
  "中文标签名和列表符号也要认。",
);
assert.deepEqual(
  parseTagTranslation("翻译结果：\n```\n1girl, looking back, snow\n```"),
  { positive: "1girl, looking back, snow", negative: "" },
  "前面先来一句解释时，要跳过它取真正的标签行。",
);
assert.equal(parseTagTranslation("抱歉，我无法完成这个翻译"), null, "整段中文没有标签，仍然判失败。");
assert.equal(parseTagTranslation('{"positive": "蓝发", "negative": ""}'), null, "翻完还带中文不能放行。");

const envKey = (() => {
  process.env.IMAGE_API_KEY = "sk-env";
  const resolved = resolveImageGenerationSettings({ modelConfig: {} });
  delete process.env.IMAGE_API_KEY;
  return resolved;
})();
assert.equal(envKey!.apiKey, "sk-env", "环境变量也能当 Key。");

assert.equal(
  resolveImageGenerationSettings({ modelConfig: { imageApiBaseUrl: "不是地址" }, imageApiKey: "sk-page" }),
  null,
  "地址写错就当没开，不能抛。",
);
assert.equal(
  resolveImageGenerationSettings({ modelConfig: { imageApiBaseUrl: "http://api.minimaxi.com/v1" }, imageApiKey: "sk-page" }),
  null,
  "外网的 http 地址被拒（只允许 https，http 仅本机）。",
);

// 看图那把 Key 不该被画图蹭到：这是两件事。
assert.equal(
  resolveImageGenerationSettings({ modelConfig: { visionApiKey: "sk-vision" } }),
  null,
  "只有看图 Key 时画图不启用。",
);

// ── 5. 服务商响应解析 ──────────────────────────────────
assert.deepEqual(
  parseImageResponse({ data: [{ url: "https://example.com/a.jpg" }] }),
  { url: "https://example.com/a.jpg" },
);
assert.deepEqual(
  parseImageResponse({ data: [{ b64_json: "AAAA" }] }),
  { b64: "AAAA" },
);
const partial = parseImageResponse({
  data: [
    { error: { code: "1027", message: "output image failed content safety check" } },
    { url: "https://example.com/ok.jpg" },
  ],
});
assert.equal(partial.url, "https://example.com/ok.jpg", "部分失败时拿成功那张。");
const allFailed = parseImageResponse({
  data: [{ error: { code: "1027", message: "内容审核未通过" } }],
});
assert.equal(allFailed.error, "内容审核未通过");
assert.equal(parseImageResponse({ data: [] }).error, "服务商没有返回图片");
assert.equal(
  parseImageResponse({ base_resp: { status_code: 1008, status_msg: "余额不足" } }).error,
  "余额不足",
  "MiniMax 的 base_resp 也要认。",
);

// ── 6. 落库痕迹 ────────────────────────────────────────
assert.equal(readStoredImageFlag({}), false);
assert.equal(readStoredImageFlag({ image: { path: "" } }), false, "空路径不算带过图。");
const meta = readStoredImageMeta({ image: { path: "images/c1/a.jpg", width: 1024, height: 1024 } });
assert.equal(meta!.path, "images/c1/a.jpg");
assert.equal(meta!.width, 1024);
assert.equal(readStoredImageFlag({ image: { path: "images/c1/a.jpg" } }), true);
assert.equal(readStoredImageFlag({ stickerId: "s1" }), false, "表情包不算画图。");
const generatedOnly = { image: { path: "images/c1/a.jpg" } };
assert.equal(readSentImageFlag(generatedOnly), false, "生成文件不能当成已发出");
for (const status of ["failed", "unknown"]) assert.equal(readSentImageFlag({ ...generatedOnly, replyDelivery: { image: { status } } }), false);
assert.equal(readSentImageFlag({ ...generatedOnly, replyDelivery: { image: { status: "sent" } } }), true);
assert.equal(readSentImageFlag({ replyDelivery: { image: { status: "sent" } } }), false);
assert.equal(readImageExecutionState({}), "not_requested");
assert.equal(readImageExecutionState({ imageOffer: { prompt: "an apple" } }), "offered");
assert.equal(readImageExecutionState(generatedOnly), "generated");
assert.equal(readImageExecutionState({ ...generatedOnly, replyDelivery: { image: { status: "sent" } } }), "sent");
assert.equal(readImageExecutionState({ ...generatedOnly, replyDelivery: { image: { status: "failed" } } }), "failed");
assert.equal(readImageExecutionState({ imageAttempt: { status: "generation_failed" } }), "failed");
assert.equal(readImageExecutionState({ imageAttempt: { status: "missing_prompt" } }), "failed");
assert.equal(readImageExecutionState({ replyDelivery: { image: { status: "unknown" } } }), "unknown");
assert.equal(isImageGenerationDeclined("不用再画了"), true);
assert.equal(isImageGenerationDeclined("别管我，画一张"), false);

// ── 7. DTO 透传 ────────────────────────────────────────
const dto = toCharacterDto({
  id: "c1",
  name: "测试",
  avatar: null,
  basePrompt: "",
  styleExamples: "",
  userAddress: "",
  status: "ACTIVE",
  modelConfig: {
    imageEnabled: true,
    imageChance: 12,
    imageCooldownMinutes: 45,
    imageDailyLimit: 3,
    imageModel: "MiniMax-H3-Image-Highspeed",
    imageApiBaseUrl: "https://api.minimaxi.com/v1",
    imageProvider: "minimax",
    imageSize: "landscape",
  },
  updatedAt: new Date(),
  memorySetting: null,
  channelBindings: [],
  memoryScopes: [],
} as never);
assert.equal(dto.imageEnabled, true);
assert.equal(dto.imageChance, 12);
assert.equal(dto.imageCooldownMinutes, 45);
assert.equal(dto.imageDailyLimit, 3);
assert.equal(dto.imageModel, "MiniMax-H3-Image-Highspeed");
assert.equal(dto.imageProvider, "minimax");
assert.equal(dto.imageSize, "landscape");

const dtoDefault = toCharacterDto({
  id: "c2",
  name: "默认",
  avatar: null,
  basePrompt: "",
  styleExamples: "",
  userAddress: "",
  status: "ACTIVE",
  modelConfig: {},
  updatedAt: new Date(),
  memorySetting: null,
  channelBindings: [],
  memoryScopes: [],
} as never);
assert.equal(dtoDefault.imageEnabled, false, "默认关。");
assert.equal(dtoDefault.imageChance, 5);
assert.equal(dtoDefault.imageCooldownMinutes, 30);
assert.equal(dtoDefault.imageDailyLimit, 8);
assert.equal(dtoDefault.imageSize, "square");

// ── 8. Key 存取 ────────────────────────────────────────
// 会读写 `.data/credentials-encryption.key`（本机那把），不碰数据库、不联网。
{
  const encrypted = await encryptApiKey("sk-image-from-page");
  assert.ok(encrypted.startsWith("v1."));
  assert.ok(!encrypted.includes("sk-image-from-page"), "密文里不能出现明文。");

  const config = { imageApiKeyEncrypted: encrypted };
  assert.equal(isImageApiKeySaved(config), true);
  assert.equal(isImageApiKeySaved({}), false);
  assert.equal(await resolveCharacterImageApiKey(config), "sk-image-from-page");
  assert.equal(await resolveCharacterImageApiKey({}), "", "没配时返回空串，不抛错。");
}

// ── 9. 明显的坏输入不请求接口 ──────────────────────────
// 网络失败那条路不在这里测：连不上会走到 90 秒超时，把它塞进每次 verify:local
// 只会让测试偶尔卡住。这里只守住「空描述直接返回失败」。
{
  const empty = await generateImage({
    settings: {
      provider: "minimax",
      model: DEFAULT_IMAGE_MODEL,
      apiBaseUrl: DEFAULT_MINIMAX_IMAGE_BASE,
      apiKey: "sk-test",
      size: IMAGE_SIZE_PRESETS.square,
    },
    prompt: "   ",
    characterId: "00000000-0000-0000-0000-000000000000",
  });
  assert.equal(empty.ok, false, "空描述不请求接口。");
}

// ── 10. 内联 base64：不下载、直接落盘 ──────────────────
/**
 * 这条守的是 2026-11-22 的那次线上故障：MiniMax 回了 url，图生成了，但下载
 * 那个 OSS 域名偶发连接超时，她于是「说画好了却什么都没发」。
 * 现在默认就要 base64 —— 一次请求拿到全部数据，没有第二步可以失败。
 *
 * 用桩替换 fetch，不联网、不花钱。
 */
{
  // 用 sharp 现造一张真 PNG 当桩：手写 base64 容易不是合法图片，
  // 那样测到的就是「解码失败兜底」而不是正常转码路径。
  const sharp = (await import("sharp")).default;
  const PIXEL_PNG = (await sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 220, g: 30, b: 40 } },
  }).png().toBuffer()).toString("base64");
  const originalFetch = globalThis.fetch;
  const seen: string[] = [];

  const stub = (formats: { status: number; body: unknown }[]) => {
    let call = 0;
    globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { response_format?: string };
      seen.push(String(body.response_format));
      const step = formats[Math.min(call, formats.length - 1)]!;
      call += 1;
      return new Response(JSON.stringify(step.body), { status: step.status, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
  };

  const settings = {
    provider: "minimax" as const,
    model: DEFAULT_IMAGE_MODEL,
    apiBaseUrl: DEFAULT_MINIMAX_IMAGE_BASE,
    apiKey: "sk-test",
    size: IMAGE_SIZE_PRESETS.square,
  };

  // ① 正常：拿到 b64 就直接落盘，一次请求。
  seen.length = 0;
  stub([{ status: 200, body: { created: 1, data: [{ b64_json: PIXEL_PNG }] } }]);
  const characterId = "11111111-1111-4111-8111-111111111111";
  const ok = await generateImage({ settings, prompt: "一个红苹果", characterId });
  assert.equal(ok.ok, true, "b64 内联要能直接变成一张图。");
  assert.deepEqual(seen, ["b64_json"], "默认就要 base64：少一次下载就少一个会失败的环节。");
  if (ok.ok) {
    assert.ok(ok.image.filePath.includes("images"), "图要落在 .data/images 下。");
    const bytes = await readFile(ok.image.filePath);
    assert.ok(bytes.length > 0, "落盘的文件不能是空的。");
    assert.ok(ok.image.relativePath.startsWith("images/"), "落库痕迹用相对路径。");
    await rm(ok.image.filePath, { force: true });
    await rm(dirname(ok.image.filePath), { recursive: true, force: true });
  }

  // ② 服务商不认 b64_json（400）：退回 url 再要一次，不是直接失败。
  seen.length = 0;
  stub([
    { status: 400, body: { base_resp: { status_code: 2013, status_msg: "invalid response_format" } } },
    { status: 200, body: { data: [{ b64_json: PIXEL_PNG }] } },
  ]);
  const retried = await generateImage({ settings, prompt: "一个红苹果", characterId });
  assert.deepEqual(seen, ["b64_json", "url"], "400 才重试一次，且第二次用 url。");
  if (retried.ok) {
    await rm(retried.image.filePath, { force: true });
    await rm(dirname(retried.image.filePath), { recursive: true, force: true });
  }

  // ③ 内容审核 422：不重试，别为同一句被拒的话再花一次钱。
  seen.length = 0;
  stub([{ status: 422, body: { error: { message: "content risk" } } }]);
  const rejected = await generateImage({ settings, prompt: "一个红苹果", characterId });
  assert.equal(rejected.ok, false);
  assert.deepEqual(seen, ["b64_json"], "422 是审核问题，重发一遍还是 422。");
  assert.match((rejected as { reason: string }).reason, /422/);

  globalThis.fetch = originalFetch;
}


/**
 * 本机引擎（ComfyUI）的整条链路：提交工作流 → 轮询历史 → 取图 → 落盘。
 *
 * 用桩替换 fetch，不联网、也不依赖这台机器上到底有没有装 Anima。
 * 守四件事：走的是 `/prompt` 而不是 OpenAI 那套接口、提示词被拆成了英文正向、
 * 步数与模型跟着档位走、拿到的图仍然进 `.data/images`。
 */
{
  const sharp = (await import("sharp")).default;
  const pixel = await sharp({
    create: { width: 32, height: 32, channels: 3, background: { r: 10, g: 200, b: 120 } },
  }).png().toBuffer();
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  let submitted: Record<string, { inputs?: Record<string, unknown> }> | null = null;

  globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
    const target = String(url);
    calls.push(new URL(target).pathname);
    if (target.endsWith("/prompt")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { prompt?: Record<string, { inputs?: Record<string, unknown> }> };
      submitted = body.prompt ?? null;
      return new Response(JSON.stringify({ prompt_id: "task-1" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (target.includes("/history/")) {
      return new Response(JSON.stringify({
        "task-1": {
          status: { completed: true, status_str: "success" },
          outputs: { "10": { images: [{ filename: "anima_0001.png", subfolder: "YilingSpace", type: "output" }] } },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (target.includes("/view?")) {
      return new Response(pixel, { status: 200, headers: { "content-type": "image/png" } });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  const localSettings = {
    provider: "comfyui" as const,
    model: LOCAL_IMAGE_MODELS.fast,
    apiBaseUrl: "http://127.0.0.1:8188",
    apiKey: "",
    quality: "fast" as const,
    size: "1024x1024",
  };
  const characterId = "33333333-3333-4333-8333-333333333333";
  const localOk = await generateImage({
    settings: localSettings,
    prompt: "【画面】1girl, standing in snow, upper body；【避免】bad anatomy",
    characterId,
  });
  assert.equal(localOk.ok, true, "本地引擎出图也要能拿到文件。");
  assert.equal(localOk.ok && localOk.mode, "text_to_image");
  assert.ok(calls.includes("/prompt"), "走 ComfyUI 的 /prompt，而不是 /images/generations。");
  assert.ok(!calls.some(call => call.includes("/images/")), "本地引擎不该碰云端那条接口。");
  if (localOk.ok) {
    assert.ok(localOk.image.relativePath.startsWith("images/"), "落库痕迹和云端那张同形。");
    const bytes = await readFile(localOk.image.filePath);
    assert.ok(bytes.length > 0, "落盘的文件不能是空的。");
    await rm(localOk.image.filePath, { force: true });
    await rm(dirname(localOk.image.filePath), { recursive: true, force: true });
  }

  const graph = submitted as Record<string, { inputs?: Record<string, unknown> }> | null;
  const positiveText = String(graph?.["4"]?.inputs?.text ?? "");
  assert.match(positiveText, /1girl, standing in snow, upper body/, "画面描述要进正向提示词。");
  assert.ok(!positiveText.includes("【画面】") && !positiveText.includes("【避免】"), "中文段落标签不能进提示词。");
  assert.match(positiveText, /masterpiece, best quality/, "要自己补质量词 —— 聊天模型不会照 Anima 的格式写。");
  assert.equal(String(graph?.["1"]?.inputs?.unet_name ?? ""), LOCAL_IMAGE_MODELS.fast, "快速档用 Turbo。");
  assert.equal(graph?.["8"]?.inputs?.steps, 12);
  assert.equal(graph?.["8"]?.inputs?.cfg, 1, "Turbo 必须 CFG 1。");
  assert.match(String(graph?.["5"]?.inputs?.text ?? ""), /bad anatomy/, "【避免】进负面提示词。");

  // 中文提示词：先交给调用方注入的翻译（角色自己的聊天模型），再进引擎。
  let translateInput: { positive: string; negative: string } | null = null;
  const translated = await generateImage({
    settings: localSettings,
    prompt: "【人物】蓝紫色长发、蓝色眼睛；【画面】雪中回头",
    characterId,
    translatePrompt: async (parts) => {
      translateInput = parts;
      return { positive: "1girl, purple hair, blue eyes, looking back, snow", negative: "bad anatomy" };
    },
  });
  assert.equal(translated.ok, true);
  assert.ok(translateInput, "有中文就必须走一次翻译。");
  assert.equal(translateInput!.positive, "蓝紫色长发、蓝色眼睛, 雪中回头", "翻译拿到的已经是拆好的两半，没有【】标签。");
  const translatedGraph = submitted as Record<string, { inputs?: Record<string, unknown> }> | null;
  const translatedText = String(translatedGraph?.["4"]?.inputs?.text ?? "");
  assert.match(translatedText, /purple hair, blue eyes, looking back, snow/, "送进引擎的必须是翻好的英文。");
  assert.ok(!/[\u4e00-\u9fff]/u.test(translatedText), "翻完还留中文就等于没翻。");
  if (translated.ok) {
    await rm(translated.image.filePath, { force: true });
    await rm(dirname(translated.image.filePath), { recursive: true, force: true });
  }

  // 翻译失败（返回 null）：退回原文继续出图 —— 图差一点，也胜过整轮哑火。
  const fallback = await generateImage({
    settings: localSettings,
    prompt: "【画面】雪中回头",
    characterId,
    translatePrompt: async () => null,
  });
  assert.equal(fallback.ok, true, "翻译失败不能连累出图。");
  assert.match(String((submitted as Record<string, { inputs?: Record<string, unknown> }> | null)?.["4"]?.inputs?.text ?? ""), /雪中回头/u);
  if (fallback.ok) {
    await rm(fallback.image.filePath, { force: true });
    await rm(dirname(fallback.image.filePath), { recursive: true, force: true });
  }

  /**
   * 形象档案参考图：本机引擎以前把 references 丢掉，日志写着「这次不用参考图」。
   * 现在必须真的走图生图：上传参考图 → LoadImage → VAEEncode → denoise < 1。
   */
  {
    const calls: string[] = [];
    let graphWithReference: Record<string, { class_type?: string; inputs?: Record<string, unknown> }> | null = null;
    globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
      const target = String(url);
      calls.push(new URL(target).pathname);
      if (target.endsWith("/upload/image")) {
        assert.ok(init?.body instanceof FormData, "参考图必须走 ComfyUI 的 multipart 上传。");
        return new Response(JSON.stringify({ name: "reference.png" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (target.endsWith("/prompt")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { prompt?: Record<string, { class_type?: string; inputs?: Record<string, unknown> }> };
        graphWithReference = body.prompt ?? null;
        return new Response(JSON.stringify({ prompt_id: "task-ref" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (target.includes("/history/")) {
        return new Response(JSON.stringify({
          "task-ref": {
            status: { completed: true, status_str: "success" },
            outputs: { "10": { images: [{ filename: "anima_ref.png", subfolder: "YilingSpace", type: "output" }] } },
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (target.includes("/view?")) {
        return new Response(pixel, { status: 200, headers: { "content-type": "image/png" } });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const withReference = await generateImage({
      settings: localSettings,
      prompt: "【画面】1girl, standing by the window",
      characterId,
      references: [
        { label: "标准形象", mime: "image/png", buffer: pixel },
        { label: "正面视图", mime: "image/png", buffer: pixel },
      ],
    });
    assert.equal(withReference.ok, true, "带形象档案时也要能出图。");
    assert.equal(withReference.ok ? withReference.mode : "", "image_to_image", "有参考图就必须走图生图。");
    assert.ok(calls.includes("/upload/image"), "参考图要先上传给引擎。");
    const refGraph = graphWithReference as Record<string, { class_type?: string; inputs?: Record<string, unknown> }> | null;
    assert.equal(refGraph?.["6"]?.class_type, "LoadImage", "参考图必须真的进工作流。");
    assert.equal(refGraph?.["7"]?.class_type, "VAEEncode");
    const denoise = Number(refGraph?.["8"]?.inputs?.denoise);
    assert.ok(denoise > 0.3 && denoise < 1, "带参考图时 denoise 必须在 0.3~0.85 之间，不能是 1（那等于没用参考图）。");
    if (withReference.ok) {
      await rm(withReference.image.filePath, { force: true });
      await rm(dirname(withReference.image.filePath), { recursive: true, force: true });
    }
  }

  // 引擎没开：不能抛，只能给一句能照着做的原因。
  globalThis.fetch = (async () => {
    throw new Error("ECONNREFUSED 127.0.0.1:8188");
  }) as typeof fetch;
  const offline = await generateImage({ settings: localSettings, prompt: "1girl", characterId });
  assert.equal(offline.ok, false, "引擎没开时这轮只发文字。");
  assert.match((offline as { reason: string }).reason, /ComfyUI|连不上/u, "原因里要能看出是引擎没开。");

  globalThis.fetch = originalFetch;
}


/**
 * 参考图请求回归：用本地 mock fetch 验证 multipart / MiniMax 原生 JSON / 文生图回退。
 * 不联网、不使用真实 Key、不产生服务商费用。
 */
{
  const sharp = (await import("sharp")).default;
  const pixel = await sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 20, g: 120, b: 210 } },
  }).png().toBuffer();
  const pixelBase64 = pixel.toString("base64");
  const originalFetch = globalThis.fetch;
  const characterId = "22222222-2222-4222-8222-222222222222";
  const references = [
    { assetId: "asset-standard", label: "标准形象", mime: "image/png", buffer: pixel },
    { assetId: "asset-front", label: "正面视图", mime: "image/png", buffer: pixel },
  ];
  const prompt = "【人物】蓝紫色头发；【参考图】图1 标准形象、图2 正面视图——只用来确定长相；【画面】窗边回眸";

  const cleanup = async (result: Awaited<ReturnType<typeof generateImage>>) => {
    if (!result.ok) return;
    await rm(result.image.filePath, { force: true });
    await rm(dirname(result.image.filePath), { recursive: true, force: true });
  };
  const response = () => new Response(JSON.stringify({ data: [{ b64_json: pixelBase64 }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

  try {
    // ① OpenAI edits：multipart 必须真的包含图像 Blob，不能只在 prompt 里提图。
    {
      const calls: Array<{ url: string; body: unknown }> = [];
      globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
        calls.push({ url: String(url), body: init?.body });
        return response();
      }) as typeof fetch;
      const result = await generateImage({
        settings: { provider: "openai", model: "gpt-image-1", apiBaseUrl: "https://edits-test.example/v1", apiKey: "sk-test", size: "1024x1024" },
        prompt,
        characterId,
        references,
      });
      assert.equal(result.ok, true, "edits multipart 请求应成功");
      assert.equal(result.ok ? result.mode : "", "image_to_image");
      assert.equal(calls.length, 1);
      assert.ok(calls[0]!.url.endsWith("/images/edits"));
      assert.ok(calls[0]!.body instanceof FormData, "edits 请求体必须是 FormData");
      const form = calls[0]!.body as FormData;
      assert.equal(form.get("model"), "gpt-image-1");
      assert.equal(form.get("prompt"), prompt);
      assert.ok(form.get("image[]") instanceof Blob, "多张参考图必须作为 image[] Blob 发送");
      assert.ok(form.getAll("image[]").length === 2);
      await cleanup(result);
    }

    // ② edits 路由不存在时尝试 MiniMax 原生 subject_reference，且提示词同步只保留图 1。
    {
      const calls: Array<{ url: string; body: unknown }> = [];
      globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
        const urlText = String(url);
        calls.push({ url: urlText, body: init?.body });
        if (urlText.endsWith("/images/edits")) return new Response("not found", { status: 404 });
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          prompt: string;
          subject_reference: Array<{ image_file: string }>;
        };
        assert.ok(body.prompt.includes("图1 标准形象"));
        assert.ok(!body.prompt.includes("图2"), "单图形状不能保留未发送图片的说明");
        assert.equal(body.subject_reference.length, 1);
        assert.ok(body.subject_reference[0]!.image_file.startsWith("data:image/png;base64,"));
        assert.ok(body.subject_reference[0]!.image_file.endsWith(pixelBase64));
        return new Response(JSON.stringify({ data: { image_base64: [pixelBase64] } }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }) as typeof fetch;
      const result = await generateImage({
        settings: { provider: "minimax", model: DEFAULT_IMAGE_MODEL, apiBaseUrl: "https://minimax-native-test.example/v1", apiKey: "sk-test", size: IMAGE_SIZE_PRESETS.square },
        prompt,
        characterId,
        references,
      });
      assert.equal(result.ok, true, "MiniMax 原生参考图请求应成功");
      assert.equal(result.ok ? result.mode : "", "image_to_image");
      assert.equal(calls.length, 2);
      assert.ok(calls[1]!.url.endsWith("/image_generation"));
      await cleanup(result);
    }

    // ③ 两种参考图路由都不存在时回退文生图，且必须移除空的参考图说明。
    {
      const calls: Array<{ url: string; body: unknown }> = [];
      globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
        const urlText = String(url);
        calls.push({ url: urlText, body: init?.body });
        if (urlText.endsWith("/images/edits")) return new Response("not found", { status: 404 });
        if (urlText.endsWith("/image_generation")) return new Response("method not allowed", { status: 405 });
        const body = JSON.parse(String(init?.body ?? "{}")) as { prompt: string };
        assert.ok(!body.prompt.includes("【参考图】"), "回退文生图时必须去掉参考图空指代");
        return response();
      }) as typeof fetch;
      const result = await generateImage({
        settings: { provider: "minimax", model: DEFAULT_IMAGE_MODEL, apiBaseUrl: "https://no-reference-route-test.example/v1", apiKey: "sk-test", size: IMAGE_SIZE_PRESETS.square },
        prompt,
        characterId,
        references,
      });
      assert.equal(result.ok, true);
      assert.equal(result.ok ? result.mode : "", "text_to_image");
      assert.equal(calls.length, 3, "两种参考图路由后应只调用一次文生图");
      assert.ok(calls[2]!.url.endsWith("/images/generations"));
      await cleanup(result);
    }

    // ④ 参数错误不是路由缺失：不再尝试另一种参考图形状，直接回退文生图。
    {
      const calls: string[] = [];
      globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
        const urlText = String(url);
        calls.push(urlText);
        if (urlText.endsWith("/images/edits")) return new Response("invalid image", { status: 400 });
        return response();
      }) as typeof fetch;
      const result = await generateImage({
        settings: { provider: "minimax", model: DEFAULT_IMAGE_MODEL, apiBaseUrl: "https://reference-400-test.example/v1", apiKey: "sk-test", size: IMAGE_SIZE_PRESETS.square },
        prompt,
        characterId,
        references,
      });
      assert.equal(result.ok, true);
      assert.equal(result.ok ? result.mode : "", "text_to_image");
      assert.equal(calls.length, 2, "400 不应再尝试 MiniMax 形状");
      await cleanup(result);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
}


restoreEnv();
console.log("test:image-generation —— 全部通过");