/**
 * 画图（文生图）链路的纯逻辑测试：判定、规划、配置解析、响应解析、落库痕迹。
 *
 * 都不联网：真调生图接口要服务商凭据，而且要花钱，不可能进每次 verify:local。
 * 这里守的是**判据**——哪些话算让她画、什么情况下不画、什么响应算一张图。
 */

import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
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
const ENV_KEYS = ["IMAGE_MODEL", "IMAGE_BASE_URL", "IMAGE_API_KEY", "IMAGE_PROVIDER"] as const;
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

restoreEnv();
console.log("test:image-generation —— 全部通过");