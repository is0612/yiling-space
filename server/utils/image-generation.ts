/**
 * 她画画：文字 → 文生图接口 → 一张图 → 单独一条消息发出去。
 *
 * 为什么单独一条链路、而不是让聊天模型直接出图：
 *   聊天模型走的是文本 chat/completions，图片出不来。所以画图只能发生在回复生成之后：
 *   聊天模型决定「这轮要配一张图」并写出一段画面描述（`imagePrompt`），
 *   再由这里把那句话送去文生图接口、落盘、交给渠道发出去。
 *
 * 三件事必须在这里守住，别挪到调用方：
 *   1. **画图是钱**：按张计费、且单张比一次聊天贵得多。所以开关默认关、
 *      自主画图默认低概率、每天有上限、被明确要求时才无条件画。
 *   2. **url 是外部输入**：服务商返回的直链照样可能指向内网，下载走同一套白名单
 *      （`safe-media-download`），和看图、语音共用一份，别另写一套。
 *   3. **失败必须静默**：画不出来就只发文字。图是锦上添花，绝不能变成
 *      「这轮她一个字都没说」。
 *
 * 关于记账：`model_usages` 是按 token 结算的表，画图按张计费，塞进去会污染
 * 「未定价 token」统计和金额报表。所以**不写 model_usages**，只留 `[image]` 日志行。
 */

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { IMAGE_SIZE_SETS, resolveImagePixels, type ImageSizePreset } from "../../shared/utils/image-size";
import { validateChatApiBaseUrl } from "./chat-model-config";
import { dataPath } from "./data-dir";
import { downloadSafeMedia } from "./safe-media-download";

/** 默认模型。高速版是 `MiniMax-H3-Image-Highspeed`，参数完全一样。 */
export const DEFAULT_IMAGE_MODEL = "MiniMax-H3-Image";

/**
 * 默认端点。与语音那条链路保持一致用 `api.minimaxi.com`（Key 通常就是在
 * `platform.minimaxi.com` 建的，同域最省事）。文档站 `platform.minimax.cn` 给的示例地址是
 * `api.minimax.cn`，两个域名都在用 —— 401 时先怀疑这里填错了域名。
 */
export const DEFAULT_MINIMAX_IMAGE_BASE = "https://api.minimaxi.com/v1";

/**
 * 一次请求最多要几张。永远只发一张：一次弹出三四张图不像聊天，像图库。
 * 不导出、也不叫 `MAX_IMAGES_PER_TURN` —— 那个名字已经被 `image-understanding.ts`（看图）
 * 占着，两张不同用途的常量同名会让 Nuxt 的自动导入直接告警并挑错一个。
 */
const MAX_IMAGES_PER_CALL = 1;

/** 画面描述上限。32000 是服务商上限，但真正该由提示词约束，这里只防跑飞。 */
export const IMAGE_PROMPT_MAX_CHARS = 1200;

/** 下载上限 12MB：1024 级别的 jpeg 正常不到 2MB，超了就是异常响应。 */
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 15_000;
/**
 * 生成超时。实测 MiniMax 十几到几十秒，比聊天慢一个量级；
 * 给 90 秒是因为「等到一半放弃」会把已经计费的那张图直接扔掉。
 */
const GENERATE_TIMEOUT_MS = 90_000;

/**
 * 试过、两种参考图形状都不认的地址。
 *
 * 只记路由级 404/405 —— 超时、审核、参数错下次还该试，不能因为一次抖动就把人钉死。
 * 进程内有效，重启就清空：多花一两次探测请求，好过因为一条陈旧判断挡住一个能用的服务商。
 */
const noReferenceRoute = new Set<string>();
const MODEL_MAX_CHARS = 120;

/** 发到 QQ 前缩到的最长边。1280 在手机上清晰、base64 也只有几百 KB。 */
export const IMAGE_MAX_EDGE = 1280;

/**
 * 尺寸档位。给的是「方 / 竖 / 横」而不是像素，因为用户想的是构图不是分辨率。
 *
 * 这里保留的是 **MiniMax** 那一套（864×1152 等三个值都满足它 655,360 px 的面积下限）。
 * 实际发请求时按服务商重新解析，见 `resolveImagePixels` —— OpenAI 那几家不认 864×1152。
 */
export const IMAGE_SIZE_PRESETS: Record<ImageSizePreset, string> = IMAGE_SIZE_SETS.minimax;

export type ImageGenerationProvider = "minimax" | "openai";

export type ImageGenerationSettings = {
  provider: ImageGenerationProvider;
  model: string;
  apiBaseUrl: string;
  apiKey: string;
  /** 已经换算成 `宽x高` 的像素值。 */
  size: string;
};

export type GeneratedImage = {
  /** 落盘的绝对路径（发图时读它）。 */
  filePath: string;
  /** 相对 `.data` 的路径，写进消息 metadata；换机器/换目录后仍能定位。 */
  relativePath: string;
  mime: string;
  width: number;
  height: number;
  bytes: number;
};

/**
 * 一张随请求发出去的参考图。
 *
 * 只接受已经在服务端校验过路径的字节 —— 这里的 buffer 会直接进 multipart，
 * 不做任何来源判断，判断在 `visual-profile-references` 那一层做完了。
 */
export type ImageReferenceInput = {
  /** 对应【参考图】段里的中文名，只用于日志。 */
  label: string;
  mime: string;
  buffer: Buffer;
};

export type ImageGenerationResult =
  /** mode 记录的是**实际**用了哪条路径：edits 失败回退后仍然是 text_to_image。 */
  | { ok: true; image: GeneratedImage; mode: "text_to_image" | "image_to_image" }
  | { ok: false; reason: string };

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** 她能不能画图：角色级开关，默认关（同 `emojiEnabled` / `voiceEnabled` 的路子）。 */
export function isImageGenerationEnabled(configValue: unknown): boolean {
  return asRecord(configValue).imageEnabled === true;
}

/**
 * 她自己想画一张的概率（百分比，0-100）。**默认 5**。
 *
 * 为什么不给更高：单张图比一次聊天贵一到两个数量级，而且生成要等几十秒。
 * 被明确要求时（`isImageRequested`）不看这个概率、也不看冷却，直接画。
 */
export function resolveImageChance(configValue: unknown): number {
  const raw = asRecord(configValue).imageChance;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 5;
  return Math.min(100, Math.max(0, Math.round(raw)));
}

/** 两张自主配图之间至少隔多少分钟。**0 = 不冷却**。默认 30。 */
export const DEFAULT_IMAGE_COOLDOWN_MINUTES = 30;
const IMAGE_COOLDOWN_MAX_MINUTES = 24 * 60;

export function resolveImageCooldownMinutes(configValue: unknown): number {
  const raw = asRecord(configValue).imageCooldownMinutes;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_IMAGE_COOLDOWN_MINUTES;
  return Math.min(IMAGE_COOLDOWN_MAX_MINUTES, Math.max(0, Math.round(raw)));
}

export function resolveImageCooldownMs(configValue: unknown): number {
  return resolveImageCooldownMinutes(configValue) * 60 * 1000;
}

/** 每天最多画几张（角色级，东八区日界）。默认 8，0 = 不限。 */
export const DEFAULT_IMAGE_DAILY_LIMIT = 8;

export function resolveImageDailyLimit(configValue: unknown): number {
  const raw = asRecord(configValue).imageDailyLimit;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_IMAGE_DAILY_LIMIT;
  return Math.min(200, Math.max(0, Math.round(raw)));
}

/** 尺寸档位：只认三个预设名，写错当方图。 */
export function resolveImageSizePreset(configValue: unknown): ImageSizePreset {
  const raw = asRecord(configValue).imageSize;
  return raw === "portrait" || raw === "landscape" ? raw : "square";
}

function isKnownProvider(value: string): value is ImageGenerationProvider {
  return value === "minimax" || value === "openai";
}

/**
 * 解析画图配置。返回 null = 不画（默认状态，不是错误）。
 *
 * 优先级：
 *   模型：`modelConfig.imageModel` > `IMAGE_MODEL` > 默认 `MiniMax-H3-Image`
 *   地址：`modelConfig.imageApiBaseUrl` > `IMAGE_BASE_URL` > minimax 默认 / 聊天地址
 *   Key ：`modelConfig.imageApiKey`（已解密）> `IMAGE_API_KEY`
 *
 * **不像看图那样回落到聊天 Key**：看图回落是对的（gpt-4o-mini 本身能读图），
 * 但画图几乎必然是另一家服务（DeepSeek 没有生图接口），把聊天 Key 打过去只会 401，
 * 而报错里只写「鉴权失败」。少一条回落，少一种查不出来的错。
 */
export function resolveImageGenerationSettings(input: {
  modelConfig?: unknown;
  chatApiBaseUrl?: string;
  imageApiKey?: string;
}): ImageGenerationSettings | null {
  const config = asRecord(input.modelConfig);
  const explicitProvider = readString(config.imageProvider) || readString(process.env.IMAGE_PROVIDER);
  const explicitBase = readString(config.imageApiBaseUrl) || readString(process.env.IMAGE_BASE_URL);
  const chatBase = input.chatApiBaseUrl ?? "";
  /**
   * 服务商：显式配了就用，没配看地址里有没有 minimax。
   * 两个地址都没有时按 minimax 算 —— 默认模型就是 MiniMax 的，
   * 只填一把 Key 的人想要的显然是「直接能用」，而不是「猜成 OpenAI 再 401」。
   */
  const provider: ImageGenerationProvider = isKnownProvider(explicitProvider)
    ? explicitProvider
    : (/minimax/i.test(explicitBase || chatBase)
      ? "minimax"
      : (explicitBase || chatBase ? "openai" : "minimax"));

  const model = (readString(config.imageModel)
    || readString(process.env.IMAGE_MODEL)
    || DEFAULT_IMAGE_MODEL).slice(0, MODEL_MAX_CHARS);

  const baseRaw = explicitBase
    || (provider === "minimax" ? DEFAULT_MINIMAX_IMAGE_BASE : chatBase || DEFAULT_MINIMAX_IMAGE_BASE);
  let apiBaseUrl: string;
  try {
    apiBaseUrl = validateChatApiBaseUrl(baseRaw);
  } catch {
    // 地址写错当没开：一个坏 URL 不该让整轮聊天变成错误。
    return null;
  }
  if (!apiBaseUrl) return null;

  /**
   * Key 里去掉所有空白。
   *
   * `trim()` 只管两头，而从控制台复制 JWT 时正文很容易带上换行或被折行 ——
   * MiniMax 那把 Key 有近两百个字符，中间夹一个 `\n` 就是服务商眼里的
   * `invalid_api_key`，界面上却看不出任何异常。API Key 永远不含空白字符，
   * 删干净不会有副作用。
   */
  const apiKey = (input.imageApiKey?.trim() || readString(process.env.IMAGE_API_KEY)).replace(/\s+/gu, "");
  if (!apiKey) return null;

  return {
    provider,
    model,
    apiBaseUrl,
    apiKey,
    size: resolveImagePixels(provider, model, resolveImageSizePreset(config)),
  };
}

export function buildImageGenerationEndpoint(baseUrl: string): URL {
  const normalized = baseUrl.replace(/\/+$/, "");
  return new URL(`${normalized}/images/generations`);
}

/** 带参考图走的是 OpenAI 的 edits 语义（multipart）。不是每家都实现，失败会回退。 */
export function buildImageEditEndpoint(baseUrl: string): URL {
  const normalized = baseUrl.replace(/\/+$/, "");
  return new URL(`${normalized}/images/edits`);
}

/**
 * MiniMax 原生图生图：和文生图同一个接口，靠 `subject_reference` 带参考图。
 *
 * 注意路径是单数 `/image_generation`，跟 OpenAI 的 `/images/generations` 不是一回事。
 */
export function buildMinimaxImageEndpoint(baseUrl: string): URL {
  const normalized = baseUrl.replace(/\/+$/, "");
  return new URL(`${normalized}/image_generation`);
}

/**
 * 401/403 里「不是 Key 的事」那一类，单独认出来。
 *
 * 2026-11-23 实测：一台中转对画图请求回 403
 * `{"error":{"message":"this group is not served by this gateway","type":"Forbidden"}}`
 * —— 意思是**当前令牌所在的令牌分组里没有能服务这个模型的渠道**。
 * 早先这里按状态码一律说「Key 无效或没有该模型的权限」，人于是去重贴 Key、
 * 去控制台翻权限，全白费；真正该做的是换模型，或者在中转后台把模型加进分组。
 *
 * 同一件事各家措辞不同（new-api / one-api 类网关尤其爱换说法），所以认几组关键词；
 * 认不出就返回 null，让调用方按状态码给通用话术 —— 不猜比猜错强。
 */
export function describeImageGatewayRefusal(detail: string): string | null {
  if (!detail) return null;
  const groupRefused = /this group is not served|not served by this gateway|group\s+is\s+not\s+served/i.test(detail);
  const noChannel = /no available channel|无可用渠道|没有可用渠道|渠道.*(不可用|未配置|不存在)/i.test(detail);
  const groupModelRefused = /(分组|group)[^。；]{0,40}(不可用|未开通|无权|不支持|not\s+support|not\s+available)/i.test(detail);
  if (!groupRefused && !noChannel && !groupModelRefused) return null;
  return "网关拒绝了这次请求：当前令牌所在的分组没有能服务这个模型的渠道（原话类似 this group is not served by this gateway），不是 Key 填错了。先去「获取模型」看这家到底有哪些画图模型，或者在中转后台把这个模型加进当前令牌的分组。";
}

/* ────────────────────────────── 什么时候画 ────────────────────────────── */

/**
 * 明显是别的东西的词。命中了就不当画图请求。
 *
 * 「画重点」「画圈」「画饼」是口语里最常见的三个假阳性，
 * 而「漫画 / 动画 / 画风」是在聊作品，不是让她动笔。
 */
/** Only anchored commands in genuine text segments are considered. */
export type ExplicitImageRequest = { subject?: string; retry: boolean };
export function parseExplicitImageRequest(commandText: string): ExplicitImageRequest | null {
  if (!commandText || commandText.length > 4000) return null;
  const clauses = commandText.split(/[，,。；;！!？?\n]+/u).map(text => text.trim()).filter(Boolean);
  let found: ExplicitImageRequest | null = null;
  for (const clause of clauses) {
    let text = clause.replace(/\s+/gu, "");
    text = text.replace(/^(?:嗯嗯|嗯|好啊|好的|好|行|那|那么|这次|现在)+/u, "");
    if (/^(?:别|不要|不用|不必|甭|停止)(?:再)?(?:画|绘制|生成|出图|生图)/u.test(text)) { found = null; continue; }
    if (/^(?:我|他|她|它|我们|他们|她们|别人|群友)/u.test(text)) continue;
    if (/(?:提示词|怎么画|为什么|如何|画得|画的|画了吗|画好了吗|画好了没|画画的|画画功能)/u.test(text)) continue;
    text = text.replace(/^(?:请|麻烦你|麻烦|你|帮我|给我|替我)+/u, "");
    text = text.replace(/^(?:能不能|可不可以|可以|能|会)(?:帮我|给我|替我)?/u, "");
    const retry = /^(?:再|又|继续)/u.test(text);
    text = text.replace(/^(?:再|又|继续)+/u, "");
    const match = /^(画|绘制|绘|生成|来|出|整|搞|做)(.*)$/u.exec(text);
    if (!match) continue;
    const verb = match[1]!; let tail = match[2]!;
    if (/^(?:重点|圈|线|饼|风|质|师|画课|外音|画的|画功能)/u.test(tail)) continue;
    if (/^(?:一次|几次|一遍|几遍|几回|一回)(?:试试|看看)?(?:吧|呀|啊|呢|吗|么|嘛)?$/u.test(tail)) { found = { retry: true }; continue; }
    if (/^(?:一下|试试|看看)?(?:吧|呀|啊)?$/u.test(tail) && /^(?:画|绘制)$/u.test(verb)) { found = { retry }; continue; }
    // Generic ability questions never authorize a paid call.
    if (/^(?:图|画|画画|生图|出图)(?:吗|么|嘛|呢)?$/u.test(tail)) continue;
    const amount = /^(?:一|两|几|二|三)?(?:张|幅|只|个|条|朵|片|座|间|副)/u.exec(tail);
    if (amount) tail = /^(?:一|两|几|二|三)(?:只|条|朵|片|座|间)$/u.test(amount[0])
      ? tail : tail.slice(amount[0].length);
    else if (!/^(?:照片|插画|头像|壁纸|海报|表情包|贴纸|立绘|场景|风景|画面)/u.test(tail)) continue;
    tail = tail.replace(/(?:试试|看看|呗|吧|呀|啊|呢|吗|么|嘛)+$/u, "");
    // A count-only command may reuse an approved visual prompt, never raw dialogue.
    if (!tail || /^(?:图|画|图片)$/u.test(tail)) { found = { retry }; continue; }
    if (/^(?:来|出|整|搞|做|生成)$/u.test(verb) && !/^(?:图|画|图片|照片|插画|头像|壁纸|海报|表情包|贴纸|立绘|场景|风景|画面)/u.test(tail)) continue;
    found = { subject: tail, retry };
  }
  return found;
}
export function isImageRequested(text: string): boolean { return parseExplicitImageRequest(text) !== null; }
export function isImageGenerationDeclined(text: string): boolean {
  return text.split(/[，,。；;！!？?\n]+/u).some(clause => /^(?:那|现在|你|请)*(?:别|不要|不用|不必|甭|停止)(?:再)?(?:画|绘制|生成|出图|生图)/u.test(clause.replace(/\s+/gu, "")));
}

export type ImageReplyDecisionInput = {
  modelConfig: unknown; channelSupported?: boolean; configured?: boolean;
  request?: { kind: "direct" | "confirmation" | "none" | "declined" | "status"; reason?: string };
  todayCount?: number | null; lastImageAt?: Date | null; now?: Date; random?: () => number;
  voicePlanned?: boolean; allowAutonomous?: boolean; promptValidation?: { ok: boolean; reason?: "missing_prompt" | "unsafe_prompt" };
};
export type ImageReplyDecision = {
  status: "approved" | "blocked" | "not_requested";
  trigger: "direct" | "confirmed_offer" | "autonomous" | "none";
  requested: boolean; blockedReason?: import("./image-request-policy").ImageBlockedReason;
  todayCount: number | null; limit: number;
};
export function planImageReplyDecision(input: ImageReplyDecisionInput): ImageReplyDecision {
  const kind = input.request?.kind ?? "none";
  const requested = kind === "direct" || kind === "confirmation" || ["confirmation_required", "offer_expired", "ambiguous_request"].includes(input.request?.reason ?? "");
  const base: ImageReplyDecision = { status: "approved", trigger: kind === "direct" ? "direct" : kind === "confirmation" ? "confirmed_offer" : "autonomous", requested,
    todayCount: input.todayCount === null ? null : input.todayCount ?? 0, limit: resolveImageDailyLimit(input.modelConfig) };
  const block = (reason: NonNullable<ImageReplyDecision["blockedReason"]>): ImageReplyDecision => ({ ...base, status: requested ? "blocked" : "not_requested", blockedReason: reason, ...(!requested ? { trigger: "none" as const } : {}) });
  if (input.channelSupported === false) return block("channel_unsupported");
  if (!isImageGenerationEnabled(input.modelConfig)) return block("disabled");
  if (input.configured === false) return block("missing_config");
  if (kind === "declined") return block("declined");
  if (kind === "status") return block("status_query");
  if (input.request?.reason) return block(input.request.reason as NonNullable<ImageReplyDecision["blockedReason"]>);
  if (base.todayCount === null || !Number.isFinite(base.todayCount) || base.todayCount < 0) return block("quota_unavailable");
  if (base.limit > 0 && base.todayCount >= base.limit) return block("daily_limit");
  if (input.voicePlanned) return block("voice_conflict");
  if (input.promptValidation?.ok === false) return block(input.promptValidation.reason ?? "unsafe_prompt");
  if (requested) return base;
  if (input.allowAutonomous === false) return { ...base, status: "not_requested", trigger: "none" };
  const now = input.now ?? new Date();
  if (input.lastImageAt && resolveImageCooldownMs(input.modelConfig) > 0 && now.getTime() - input.lastImageAt.getTime() < resolveImageCooldownMs(input.modelConfig)) return block("cooldown");
  const chance = resolveImageChance(input.modelConfig);
  if (chance <= 0 || (input.random ?? Math.random)() * 100 >= chance) return block("chance");
  return base;
}
/** Legacy boolean API delegates to the exact same planning decision. */
export function planImageReply(input: { modelConfig: unknown; lastImageAt?: Date | null; todayCount?: number | null; now?: Date; random?: () => number; force?: boolean }): boolean {
  return planImageReplyDecision({ ...input, request: { kind: input.force ? "direct" : "none" } }).status === "approved";
}

/**
 * 画面描述清洗：压成一行、限长。
 *
 * 换行对生图接口没有意义，但模型爱写「主体：…\n风格：…」这种结构，
 * 压成一行反而更容易被服务商当成一段完整描述。
 */
export function sanitizeImagePrompt(raw: string): string {
  return raw
    .replace(/\s*\n+\s*/g, "，")
    .replace(/\s{2,}/g, " ")
    .replace(/^[，,、;；\s]+/u, "")
    .trim()
    .slice(0, IMAGE_PROMPT_MAX_CHARS)
    .trim();
}

/**
 * 去掉提示词里的【参考图】段。
 *
 * 参考图没发出去时留着这段，模型会把它当成「有一张叫图1 的参考图」去想象。
 * 那一段内部只用「、」和「，」，不会出现「；」，所以按分号切就够。
 */
export function withoutReferenceNotes(prompt: string): string {
  const stripped = prompt
    .replace(/【参考图】[^；]*(?:；|$)/u, "")
    .replace(/；{2,}/gu, "；")
    .replace(/^；+|；+$/gu, "")
    .trim();
  return stripped || prompt;
}

/**
 * 只留下前 N 张参考图的说明。
 *
 * 提示词是按最多 4 张拼的，而有些形状（MiniMax 的 subject_reference）一次只吃一张；
 * 不裁掉后面的，模型会以为还有几张图是它没收到、但应该照着画的。
 */
export function limitReferenceNotes(prompt: string, keep: number): string {
  return prompt.replace(/【参考图】([^—]*)——/u, (_match, list: string) => {
    const items = String(list).split("、").map(item => item.trim()).filter(Boolean).slice(0, keep);
    return items.length ? `【参考图】${items.join("、")}——` : "";
  });
}

/**
 * 模型没给画面描述时的兜底：拿这句原话去画。
 *
 * 只去掉「画一张」这类指令词，保留宾语。这样「画只橘猫趴在窗台上」不会变成
 * 一张写着「画只橘猫趴在窗台上」的图 —— 而是真的橘猫。
 */
export function promptFromRequest(text: string): string {
  return sanitizeImagePrompt(parseExplicitImageRequest(text)?.subject ?? "");
}

/* ────────────────────────────── 调接口 ────────────────────────────── */

/**
 * 从响应里挑出第一张成功的图。
 *
 * 两种返回形状都要认：
 *   - `data[].url`（MiniMax / OpenAI 默认，链接 24 小时有效）
 *   - `data[].b64_json`（部分模型只回 base64）
 * 部分失败（`data[].error`）是正常现象：MiniMax 只要有一张成功就回 200。
 */
export function parseImageResponse(payload: unknown): { url?: string; b64?: string; error?: string } {
  const record = asRecord(payload);

  // MiniMax 的语音接口把错误藏在 base_resp 里，图片接口文档没写，但认一下不亏。
  const baseResp = asRecord(record.base_resp);
  const baseCode = typeof baseResp.status_code === "number" ? baseResp.status_code : 0;
  if (baseCode !== 0) {
    return { error: typeof baseResp.status_msg === "string" ? baseResp.status_msg : `base_resp ${baseCode}` };
  }

  const data = Array.isArray(record.data) ? record.data : [];
  let firstError = "";
  for (const item of data) {
    const entry = asRecord(item);
    const error = asRecord(entry.error);
    if (Object.keys(error).length) {
      if (!firstError) firstError = typeof error.message === "string" ? error.message : "生成失败";
      continue;
    }
    const url = typeof entry.url === "string" ? entry.url.trim() : "";
    if (url) return { url };
    const b64 = typeof entry.b64_json === "string" ? entry.b64_json.trim() : "";
    if (b64) return { b64 };
  }
  if (firstError) return { error: firstError };

  /**
   * MiniMax 原生形状：`data` 是个对象而不是数组，图片在
   * `data.image_base64` / `data.image_urls` 里。
   */
  const native = asRecord(record.data);
  for (const item of Array.isArray(native.image_base64) ? native.image_base64 : []) {
    if (typeof item === "string" && item.trim()) return { b64: item.trim() };
  }
  for (const item of Array.isArray(native.image_urls) ? native.image_urls : []) {
    if (typeof item === "string" && item.trim()) return { url: item.trim() };
  }
  return { error: "服务商没有返回图片" };
}

export type AsyncImageTask = { taskId: string; statusCode: number | null };

/**
 * 认出「异步任务式」的响应：服务商收下请求，但只回一个 task_id，图片要再查一次。
 *
 * 2026-11-23 从中转那边确认的说法：作图久的时候会拿到 `65535` 这类业务码，
 * 换成 `response_format: b64_json` 后图片跟着同步响应一起回来。我们的请求
 * 本来就是 b64_json 优先（见 generateImage 里那段注释），正常路径走不到这里；
 * 但**换一台只支持异步的中转**时，返回的就是任务号而不是图。
 *
 * 这种情况必须和「这个模型不是生图模型」分开说：后者要换模型，前者要换接口形态，
 * 混成一句会把人的排查方向带偏（尤其是连图片地址都没填对的时候）。
 */
export function detectAsyncImageTask(payload: unknown): AsyncImageTask | null {
  const record = asRecord(payload);
  const data = asRecord(record.data);
  const task = asRecord(record.task);
  const taskId = readString(record.task_id) || readString(data.task_id) || readString(task.id);
  if (!taskId) return null;
  const baseResp = asRecord(record.base_resp);
  const statusCode = typeof baseResp.status_code === "number" ? baseResp.status_code : null;
  return { taskId, statusCode };
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).replace(/\s+/gu, " ").slice(0, 240);
  } catch {
    return "";
  }
}

/**
 * 送到 QQ 之前统一转成 jpeg 并缩到最长边 1280。
 *
 * 为什么一定要重编码：服务商可能回 png（4K 那张能到十几 MB），
 * base64 之后网关要再解一遍，体积越大越容易在网关侧失败；
 * 而 QQ 聊天窗的显示宽度本来就只有屏幕那么宽，4K 是白付的流量。
 *
 * 解码失败就返回原图：发不出去才是问题，清晰度不是。
 */
async function normalizeForSend(image: { buffer: Buffer; mime: string }): Promise<{
  buffer: Buffer;
  mime: string;
  width: number;
  height: number;
}> {
  try {
    const sharp = (await import("sharp")).default;
    const meta = await sharp(image.buffer).metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    const edge = Math.max(width, height);
    let pipeline = sharp(image.buffer).rotate();
    if (edge > IMAGE_MAX_EDGE) {
      pipeline = pipeline.resize({ width: IMAGE_MAX_EDGE, height: IMAGE_MAX_EDGE, fit: "inside", withoutEnlargement: true });
    }
    const output = await pipeline.jpeg({ quality: 88 }).toBuffer({ resolveWithObject: true });
    return {
      buffer: output.data,
      mime: "image/jpeg",
      width: output.info.width,
      height: output.info.height,
    };
  } catch {
    return { buffer: image.buffer, mime: image.mime, width: 0, height: 0 };
  }
}

function extensionFor(mime: string): string {
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  return "jpg";
}

/**
 * 从 magic bytes 认类型。
 *
 * 走 base64 内联时没有 HTTP 头可看，扩展名只能自己判；判错的后果是把 jpeg
 * 存成 `.png`，QQ 那边不给预览。sharp 转码成功时这一步其实不影响结果，
 * 但只要 sharp 挂了（少见，但不是零）就轮到它兜底。
 */
function sniffImageMime(buffer: Buffer): string {
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return "image/png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return "image/jpeg";
}

/** 落盘目录按角色分开：一个角色画疯了一天也就几十张，混在一起没法清。 */
function imageDir(characterId: string): string {
  return dataPath("images", characterId);
}

/** 把相对路径还原成绝对路径（发图时用）。只认 `.data` 下的相对路径。 */
export function resolveStoredImagePath(relativePath: string): string {
  const safe = relativePath.replace(/^[/\\]+/u, "");
  return dataPath(...safe.split(/[/\\]+/u));
}

/**
 * 画一张图。
 *
 * 失败一律返回 `{ ok: false, reason }`，**不抛异常**：调用方只关心「有没有图」，
 * 每一种失败都该落成同一件事 —— 这轮只发文字。原因写进日志，方便事后分诊：
 * 配置错、鉴权失败、内容审核、余额不足、超时、下载失败，修法完全不同。
 */
export async function generateImage(input: {
  settings: ImageGenerationSettings;
  prompt: string;
  characterId: string;
  n?: number;
  /** 形象档案的参考图；给了就先试 edits 接口，不行再退回纯文字。 */
  references?: ImageReferenceInput[];
}): Promise<ImageGenerationResult> {
  let prompt = sanitizeImagePrompt(input.prompt);
  if (!prompt) return { ok: false, reason: "画面描述为空" };
  let usedReferences = false;

  let endpoint: URL;
  try {
    endpoint = buildImageGenerationEndpoint(input.settings.apiBaseUrl);
  } catch {
    return { ok: false, reason: "画图地址无效" };
  }

  const count = Math.min(MAX_IMAGES_PER_CALL, Math.max(1, Math.round(input.n ?? 1)));

  const request = async (responseFormat: "b64_json" | "url"):
    Promise<{ ok: true; payload: unknown } | { ok: false; reason: string; status?: number }> => {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: "Bearer " + input.settings.apiKey,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: input.settings.model,
          prompt,
          size: input.settings.size,
          n: count,
          // gpt-image 系列（1 / 2 / 2.5）不接受这个字段、固定返回 base64，
          // 传过去会被当成未知参数直接 400；MiniMax 那边则必须靠它才拿得到图数据。
          ...(input.settings.provider === "minimax" ? { response_format: responseFormat } : {}),
        }),
        signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
      });
      if (!response.ok) {
        const detail = await safeText(response);
        // 内容审核失败是 422、余额不足是 402 —— 这两种用户能自己处理，日志里点明。
        const hint = response.status === 422
          ? "（内容审核未通过，换个说法再试）"
          : response.status === 402
            ? "（服务商余额不足）"
            : response.status === 401
              ? "（鉴权失败：地址与 Key 是不是同一家？）"
              : "";
        return {
          ok: false,
          status: response.status,
          reason: `画图接口返回 HTTP ${response.status}${hint}${detail ? `：${detail}` : ""}`,
        };
      }
      return { ok: true, payload: await response.json() };
    } catch (error) {
      const name = error instanceof Error ? error.name : "Error";
      return {
        ok: false,
        reason: name === "TimeoutError" || name === "AbortError"
          ? `画图超时（${GENERATE_TIMEOUT_MS / 1000} 秒）`
          : "画图接口连不上",
      };
    }
  };

  /**
   * 带参考图：走 OpenAI 的 edits 语义（multipart）。只有 openai 兼容的服务商才试，
   * MiniMax 那条原生接口没有这个形状。
   *
   * 这里的失败**不当作整次生成失败** —— 调用方拿到的是回退后的纯文字结果。
   * 理由和文件头那条一致：图是锦上添花，参考图更是锦上添花里的锦上添花。
   */
  const requestEdit = async (): Promise<
    { ok: true; payload: unknown } | { ok: false; reason: string; status?: number }
  > => {
    const references = input.references ?? [];
    if (!references.length) return { ok: false, reason: "没有参考图" };
    let editEndpoint: URL;
    try {
      editEndpoint = buildImageEditEndpoint(input.settings.apiBaseUrl);
    } catch {
      return { ok: false, reason: "画图地址无效" };
    }
    try {
      const form = new FormData();
      form.append("model", input.settings.model);
      form.append("prompt", prompt);
      form.append("size", input.settings.size);
      form.append("n", String(count));
      // 单张写 image、多张写 image[]：两套写法在不同服务商/版本里都出现过。
      const field = references.length > 1 ? "image[]" : "image";
      references.forEach((reference, index) => {
        const blob = new Blob([new Uint8Array(reference.buffer)], { type: reference.mime });
        form.append(field, blob, `reference-${index + 1}.${extensionFor(reference.mime)}`);
      });
      const response = await fetch(editEndpoint, {
        method: "POST",
        redirect: "error",
        // 不要手写 content-type：multipart 的 boundary 必须由运行时生成。
        headers: { authorization: "Bearer " + input.settings.apiKey },
        body: form,
        signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
      });
      if (!response.ok) {
        const detail = await safeText(response);
        const hint = response.status === 404 || response.status === 405
          ? "（这家可能没有参考图接口）"
          : response.status === 400
            ? "（参数或图片不被接受）"
            : "";
        return {
          ok: false,
          status: response.status,
          reason: `参考图生成返回 HTTP ${response.status}${hint}${detail ? `：${detail}` : ""}`,
        };
      }
      return { ok: true, payload: await response.json() };
    } catch (error) {
      const name = error instanceof Error ? error.name : "Error";
      return {
        ok: false,
        reason: name === "TimeoutError" || name === "AbortError" ? "参考图生成超时" : "参考图接口连不上",
      };
    }
  };

  /**
   * MiniMax 原生图生图：同一个 `image_generation` 接口，靠 `subject_reference` 带图。
   *
   * 官方文档写明这份参考「一张人脸」最好用，也只接受一张；我们这边把标准形象排在
   * 第一位，取第一张就够。参数名也完全不同（`aspect_ratio` / `response_format: base64`），
   * 所以它和 edits 是两条独立的路，不能互相拼。
   */
  const requestMinimaxReference = async (): Promise<
    { ok: true; payload: unknown } | { ok: false; reason: string; status?: number }
  > => {
    const references = input.references ?? [];
    if (!references.length) return { ok: false, reason: "没有参考图" };
    const reference = references[0]!;
    let endpoint: URL;
    try {
      endpoint = buildMinimaxImageEndpoint(input.settings.apiBaseUrl);
    } catch {
      return { ok: false, reason: "画图地址无效" };
    }
    const aspect = ({ "1024x1024": "1:1", "864x1152": "3:4", "1152x864": "4:3" } as Record<string, string>)[input.settings.size] ?? "1:1";
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: "Bearer " + input.settings.apiKey,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: input.settings.model,
          // 这份接口只吃一张，说明段也只提这一张，别让模型惦记没给它的图。
          prompt: limitReferenceNotes(prompt, 1),
          aspect_ratio: aspect,
          n: count,
          response_format: "base64",
          subject_reference: [{
            type: "character",
            image_file: `data:${reference.mime};base64,${reference.buffer.toString("base64")}`,
          }],
        }),
        signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
      });
      if (!response.ok) {
        const detail = await safeText(response);
        return {
          ok: false,
          status: response.status,
          reason: `参考图生成返回 HTTP ${response.status}${detail ? `：${detail}` : ""}`,
        };
      }
      return { ok: true, payload: await response.json() };
    } catch (error) {
      const name = error instanceof Error ? error.name : "Error";
      return {
        ok: false,
        reason: name === "TimeoutError" || name === "AbortError" ? "参考图生成超时" : "参考图接口连不上",
      };
    }
  };

  /**
   * 优先要 inline base64，其次才要链接 —— 这是 2026-11-22 线上踩出来的。
   *
   * MiniMax 的 `url` 指向乌兰察布的一台 OSS（`hailuo-image-*.oss-cn-wulanchabu`）。
   * 那天的情况：接口 200、图确实生成了、钱也花了，卡在下载那一步 ——
   * `UND_ERR_CONNECT_TIMEOUT`，10 秒（undici Agent 自己的 connectTimeout 默认值，
   * 比我们的 15 秒短，所以先到）。她于是说一句「画好了」然后什么都没发出来。
   *
   * base64 内联在接口响应里，少一次跨域往返，也就少一个会失败的环节。
   * 代价是响应体约 300KB —— 本地应用可以忽略。
   *
   * 2026-11-23 中转那边给了同一个结论的另一种说法：作图慢的时候会出现
   * `65535` 这类业务码，提交时带上 `response_format: b64_json`，图片数据就
   * 直接放在查询结果里、跟着大陆线路一起回来，不必再走境外那条链接。
   * 也就是说：b64 不只是「少一次下载」，在部分中转上它还是**唯一能拿到图**的方式。
   * 所以这条永远是首选，别为了省 300KB 改成 url 优先。
   */
  /**
   * 参考图不按服务商名字判断，按「这个地址究竟认哪种形状」判断。
   *
   * 两种形状轮流试：先 OpenAI 的 edits（multipart），再 MiniMax 的
   * image_generation + subject_reference（JSON）。哪条通就用哪条 ——
   * 中转、官方、自建，谁支持谁上，不需要用户先选对服务商。
   *
   * 只有 404/405 才算「这条路不存在」、值得换下一条。其它失败（参数被拒、审核、
   * 超时）说明路由是通的，换形状也没用，直接落到纯文字。
   */
  const wantsReferences = (input.references?.length ?? 0) > 0;
  let result: { ok: true; payload: unknown } | { ok: false; reason: string; status?: number } | null = null;
  let referenceFailure = "";
  if (wantsReferences && !noReferenceRoute.has(input.settings.apiBaseUrl)) {
    const shapes = [
      { name: "edits", run: requestEdit },
      { name: "minimax", run: requestMinimaxReference },
    ];
    let routeMissing = 0;
    for (const shape of shapes) {
      const outcome = await shape.run();
      if (outcome.ok) {
        result = outcome;
        usedReferences = true;
        break;
      }
      referenceFailure = outcome.reason;
      if (outcome.status === 404 || outcome.status === 405) {
        routeMissing += 1;
        continue;
      }
      break;
    }
    if (routeMissing === shapes.length) noReferenceRoute.add(input.settings.apiBaseUrl);
  }

  if (!result) {
    if (wantsReferences) {
      // 回退不是异常：只比原路径多花一两次失败请求，画出来的图和以前一模一样。
      console.warn("[image] 参考图生成不可用，退回纯文字", {
        characterId: input.characterId,
        references: input.references?.length ?? 0,
        reason: referenceFailure || "这家没有参考图接口",
      });
      // 图没发出去，提示词里那段「图1 ⋯」就成了空指代，得一起去掉。
      prompt = withoutReferenceNotes(prompt);
    }
    result = await request("b64_json");
    // 少数 MiniMax 兼容服务商不认 `response_format: b64_json`（400 参数错误）：退回 url 再要一次。
    // 只对 400 重试：422 是内容审核、402 是余额、401 是鉴权，重发一遍也是同样的结果。
    // OpenAI 那边根本没有这个参数，回退没有意义。
    if (!result.ok && result.status === 400 && input.settings.provider === "minimax") {
      result = await request("url");
    }
  }
  if (!result.ok) return { ok: false, reason: result.reason };
  const payload = result.payload;

  const parsed = parseImageResponse(payload);
  if (parsed.error || (!parsed.url && !parsed.b64)) {
    // 异步接口要单独说：任务号拿到了，不代表这里能取图（见 detectAsyncImageTask）
    const asyncTask = detectAsyncImageTask(payload);
    if (asyncTask) {
      return {
        ok: false,
        reason: `作图接口是异步的：只回了任务号 ${asyncTask.taskId}${asyncTask.statusCode === null ? "" : `（业务码 ${asyncTask.statusCode}）`}，图片要再查一次才能拿到；当前链路不支持轮询取图。`,
      };
    }
    return { ok: false, reason: parsed.error || "服务商没有返回图片" };
  }

  let raw: { buffer: Buffer; mime: string };
  if (parsed.b64) {
    const buffer = Buffer.from(parsed.b64, "base64");
    if (!buffer.length) return { ok: false, reason: "服务商返回的 base64 为空" };
    if (buffer.length > MAX_IMAGE_BYTES) return { ok: false, reason: `服务商返回的图片超过 ${MAX_IMAGE_BYTES / 1024 / 1024}MB` };
    raw = { buffer, mime: sniffImageMime(buffer) };
  } else {
    /**
     * 服务商忽略了 `b64_json`、只回链接：照旧下载。
     *
     * 链接 24 小时内有效，所以失败重试一次是值得的 —— 上面那段超时就是
     * 「一次没连上就整张图丢掉」，重试能把这类抖动挡在用户体验之外。
     */
    let lastError = "";
    let downloaded: { buffer: Buffer; mime: string } | null = null;
    for (let attempt = 0; attempt < 2 && !downloaded; attempt += 1) {
      try {
        const media = await downloadSafeMedia(parsed.url!, {
          prefix: "IMAGE",
          maxBytes: MAX_IMAGE_BYTES,
          timeoutMs: DOWNLOAD_TIMEOUT_MS,
          headers: { accept: "image/*" },
          requiredMimePrefix: "image/",
        });
        downloaded = { buffer: media.buffer, mime: media.mime };
      } catch (error) {
        lastError = error instanceof Error ? error.message : "";
      }
    }
    if (!downloaded) return { ok: false, reason: `图片下载失败${lastError ? `（${lastError}）` : ""}` };
    raw = downloaded;
  }

  const normalized = await normalizeForSend(raw);
  const fileName = `${randomUUID()}.${extensionFor(normalized.mime)}`;
  const dir = imageDir(input.characterId);
  const filePath = path.join(dir, fileName);
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(filePath, normalized.buffer, { mode: 0o600 });
  } catch (error) {
    return { ok: false, reason: `图片落盘失败：${error instanceof Error ? error.message : String(error)}` };
  }

  const relativePath = path.posix.join("images", input.characterId, fileName);
  console.log("[image] generated " + JSON.stringify({
    model: input.settings.model,
    provider: input.settings.provider,
    size: input.settings.size,
    bytes: normalized.buffer.length,
    width: normalized.width,
    height: normalized.height,
  }));

  return {
    ok: true,
    mode: usedReferences ? "image_to_image" : "text_to_image",
    image: {
      filePath,
      relativePath,
      mime: normalized.mime,
      width: normalized.width,
      height: normalized.height,
      bytes: normalized.buffer.length,
    },
  };
}

/* ────────────────────────────── 落库痕迹 ────────────────────────────── */

/** 消息 metadata 里记一张图的最小形状。 */
export type StoredImageMeta = {
  /** 相对 `.data` 的路径。 */
  path: string;
  prompt?: string;
  model?: string;
  width?: number;
  height?: number;
};

export function readStoredImageMeta(metadata: unknown): StoredImageMeta | null {
  const record = asRecord(metadata);
  const image = asRecord(record.image);
  const stored = typeof image.path === "string" ? image.path.trim() : "";
  if (!stored) return null;
  return {
    path: stored,
    ...(typeof image.prompt === "string" ? { prompt: image.prompt } : {}),
    ...(typeof image.model === "string" ? { model: image.model } : {}),
    ...(typeof image.width === "number" ? { width: image.width } : {}),
    ...(typeof image.height === "number" ? { height: image.height } : {}),
  };
}

/**
 * 这条历史消息是否生成并保存过图片，用于生成额度和自主冷却。
 * 这不是发送证明；提示词的 hadImage 必须走 readSentImageFlag。
 */
export function readStoredImageFlag(metadata: unknown): boolean {
  return readStoredImageMeta(metadata) !== null;
}

/** Generation is not delivery: only a confirmed channel receipt can establish that a picture was sent. */
export function readSentImageFlag(metadata: unknown): boolean {
  const delivery = asRecord(asRecord(metadata).replyDelivery);
  return readStoredImageFlag(metadata) && asRecord(delivery.image).status === "sent";
}

export function readImageExecutionState(metadata: unknown): "not_requested" | "offered" | "generated" | "sent" | "failed" | "unknown" {
  const record = asRecord(metadata);
  const delivery = asRecord(asRecord(record.replyDelivery).image);
  if (readSentImageFlag(metadata)) return "sent";
  if (delivery.status === "failed" || delivery.status === "unknown") return delivery.status;
  if (readStoredImageFlag(metadata)) return "generated";
  if (asRecord(record.imageAttempt).status === "generation_failed" || asRecord(record.imageAttempt).status === "missing_prompt") return "failed";
  if (typeof asRecord(record.imageOffer).prompt === "string" && (asRecord(record.imageOffer).prompt as string).trim()) return "offered";
  return "not_requested";
}
