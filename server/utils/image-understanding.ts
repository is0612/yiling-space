/**
 * QQ 群图片 → 视觉模型 → 一段中文描述。
 *
 * 为什么单独一条链路，而不是把图直接塞给聊天模型：
 *   聊天模型（例如 deepseek-flash）走的是纯文本 chat/completions，不接受 `image_url` 内容块。
 *   所以它"看图"只有一种可行姿势 —— 先由视觉模型把图变成文字，再让聊天模型读那段文字。
 *   这个文件只负责「图 → 描述」；提示词、记忆注入、落库仍然走原来的 chat-reply / pipeline。
 *
 * 默认关闭：没有配置 `VISION_MODEL`（或角色 `modelConfig.visionModel`）时整条链路不执行，
 * 群里的图仍然只是 `[图片]`，行为与接入前完全一致。这样上线不会因为一次部署就把所有人的
 * 群聊都变成"一有图就多花一次视觉调用"。
 *
 * 三件事必须在这里守住，别挪到调用方：
 *   1. **rkey 有时效**：直链只在收到消息的当口有效，必须当场下载；不要把 url 存库隔天再用。
 *   2. **url 是外部输入**：可以指向任何地方，包括内网。下载前与重定向后都要过白名单。
 *   3. **失败必须静默**：看图失败只是少了一句描述，不能让整轮回复变成错误事件。
 */


import { buildChatCompletionsEndpoint, validateChatApiBaseUrl } from "./chat-model-config";
import { resolveCharacterVisionApiKey } from "./credential-encryption";
import { readModelUsage, recordModelUsage } from "./model-usage";
import { downloadSafeMedia } from "./safe-media-download";

export {
  assertFetchableMediaUrl as assertFetchableImageUrl,
  assertPublicMediaHost as assertPublicHost,
} from "./safe-media-download";

/** 一轮最多看几张。图片描述按张计费，群里一轮三张已经够说明问题了。 */
export const MAX_IMAGES_PER_TURN = 3;

/** 单张上限 4MB：再大就不是"发张图"了，而 base64 之后体积还要再涨三分之一。 */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 8_000;
const VISION_TIMEOUT_MS = 20_000;
const DESCRIPTION_MAX_CHARS = 400;
const MODEL_MAX_CHARS = 120;

export type ChannelImageRef = {
  /** 直链，带 rkey，有时效。空字符串 = 拿不到图（表情包常见）。 */
  url: string;
  /** 网关给的文件名，只是文件名，不是本地路径。 */
  file?: string;
  /** 表情包/商城表情常常只有一句文字说明，没有 url。 */
  summary?: string;
};

export type ImageUnderstandingSettings = {
  model: string;
  apiBaseUrl: string;
  apiKey: string;
};

export type ImageUnderstandingContext = {
  characterId: string;
  channelBindingId?: string;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/**
 * 解析视觉模型配置。返回 null = 不看图（这是默认状态，不是错误）。
 *
 * 开关是**角色级显式打开**（`modelConfig.imageUnderstanding === true`），和 `emojiEnabled` 一个路子：
 * 看图必然多一次模型调用，不能因为"某台机器上配了个环境变量"就悄悄开始花钱。
 *
 * 模型优先级（都是为了不把某个具体服务商写死）：
 *   角色 `modelConfig.visionModel` > 环境变量 `VISION_MODEL` > 这个角色自己的聊天模型
 *   角色 `modelConfig.visionApiBaseUrl` > `VISION_BASE_URL` > 聊天模型自己的 Base URL
 *   角色 `modelConfig.visionApiKeyEncrypted`（已解密后传入）> `VISION_API_KEY` > 聊天模型自己的 Key
 *
 * 回落到聊天模型是刻意的：`deepseek-flash`、`gpt-4o-mini` 这类模型实测都能读图
 * （见 `docs/qq-onebot-adapter.md` 6.1.1），所以"打开开关就能用"不需要再准备第二份凭据。
 * 但那条回落有代价 —— 思考模型会在 max_tokens=400 里先把预算烧光，正文为空。
 * 所以在页面上单独配一个不思考的视觉模型才是推荐姿势，回落只作兜底。
 *
 * `options.requireSwitch = false` 只给「测试看图」用：用户想先验证模型通不通，
 * 那时不该逼他先把 QQ 群里的开关打开。
 */
export function resolveImageUnderstandingSettings(input: {
  modelConfig?: unknown;
  chatModel?: string;
  chatApiBaseUrl?: string;
  chatApiKey?: string;
  /** 已解密的角色独立视觉 Key；由 `resolveVisionSettingsForCharacter` 负责取 */
  visionApiKey?: string;
}, options: { requireSwitch?: boolean } = {}): ImageUnderstandingSettings | null {
  const config = asRecord(input.modelConfig);
  if (options.requireSwitch !== false && config.imageUnderstanding !== true) return null;

  const configuredModel = typeof config.visionModel === "string" ? config.visionModel.trim() : "";
  const model = (configuredModel
    || process.env.VISION_MODEL?.trim()
    || input.chatModel?.trim()
    || "").slice(0, MODEL_MAX_CHARS);
  if (!model) return null;

  const configuredBase = typeof config.visionApiBaseUrl === "string" ? config.visionApiBaseUrl.trim() : "";
  const baseUrlRaw = configuredBase
    || process.env.VISION_BASE_URL?.trim()
    || input.chatApiBaseUrl?.trim()
    || "";
  let apiBaseUrl: string;
  try {
    apiBaseUrl = validateChatApiBaseUrl(baseUrlRaw);
  } catch {
    // 配置写错就当没开：群里聊天不能因为一个坏 URL 整轮失败。
    return null;
  }
  if (!apiBaseUrl) return null;

  const apiKey = input.visionApiKey?.trim() || process.env.VISION_API_KEY?.trim() || input.chatApiKey?.trim() || "";
  if (!apiKey) return null;

  return { model, apiBaseUrl, apiKey };
}

/**
 * 运行时的入口：先把这个角色单独保存的视觉 Key 解出来，再走上面那套回落链。
 *
 * 之所以分成两层：`resolveImageUnderstandingSettings` 要保持**同步且纯**，
 * 它被 `scripts/test-image-understanding.ts` 当纯逻辑测（不联网、不碰数据库、不解密）。
 * 解密是异步的，所以只在这一层做。
 */
export async function resolveVisionSettingsForCharacter(
  input: {
    modelConfig?: unknown;
    chatModel?: string;
    chatApiBaseUrl?: string;
    chatApiKey?: string;
  },
  options: { requireSwitch?: boolean } = {},
): Promise<ImageUnderstandingSettings | null> {
  const visionApiKey = await resolveCharacterVisionApiKey(input.modelConfig).catch(() => "");
  return resolveImageUnderstandingSettings({ ...input, visionApiKey }, options);
}

export async function downloadImage(rawUrl: string): Promise<{ buffer: Buffer; mime: string }> {
  const result = await downloadSafeMedia(rawUrl, {
    prefix: "IMAGE",
    maxBytes: MAX_IMAGE_BYTES,
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
    headers: { accept: "image/*" },
    requiredMimePrefix: "image/",
  });
  return { buffer: result.buffer, mime: result.mime };
}

/** 把 `downloadImage` 的机器码翻成人话：这几种的修法完全不同，别糊成一句「下载失败」。 */
function describeDownloadError(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  if (code.startsWith("IMAGE_HTTP_")) {
    return `取图返回 HTTP ${code.slice("IMAGE_HTTP_".length)}（多为 rkey 过期，直链只在收到消息那几分钟有效）`;
  }
  if (code === "IMAGE_TOO_LARGE") return "图片超过 4MB 上限";
  if (code === "IMAGE_BLOCKED_HOST") return "直链指向内网/回环地址，被白名单拦了";
  if (code === "IMAGE_REDIRECT_LIMIT") return "图片下载重定向次数过多，已停止下载";
  if (code === "IMAGE_EMPTY") return "图片响应为空";
  if (code === "IMAGE_INVALID_URL" || code === "IMAGE_INVALID_PROTOCOL") return "图片直链无效或协议不受支持";
  if (code === "IMAGE_NOT_IMAGE") return "返回的不是图片（多半是防盗链跳到了 HTML）";
  return "下载超时或连不上";
}

/**
 * 提示词里为什么要专门交代「看不清就说看不清」：
 *
 * 免费的小视觉模型（`glm-4v-flash` 这类）认场面够用，抄图里的小字经常糊。而「糊」这件事
 * 从外部**看不出来** —— 它输出的是一段流畅、自信、格式正确的错字，和正确答案长得一模一样，
 * 没有置信度、没有 logprob、没有「我不确定」字段。所以「换个更准的模型」在代码里判不出来。
 *
 * 判不出来就别假装判。能做的是把不确定性如实交给她：字看不清时描述里留下「图中文字没看清」，
 * 聊天模型读到就知道该问一句「你打的啥」，而不是拿一段猜出来的错字当真事接着聊。
 *
 * 「图里本来没有文字时不用提文字」这句不能省：小模型会照着格式硬凑，给每张图都补一句
 * 「文字没看清」，那是假的不确定性，比不说更糟。
 */
const VISION_PROMPT = [
  "你在帮一个 QQ 群里的 AI 角色看群友发的图。",
  "用中文写 2-4 句，只说画面里确实存在的东西：主体、动作或场景、图里出现的文字、整体氛围。",
  "图里的文字看得清就原样抄出来；字太小、糊了、被挡住或只看到一半，就写「图中文字没看清」，不要猜，也不要把猜的字凑成通顺的句子。",
  "图里本来没有文字时，不用提文字这件事。",
  "不要开场白，不要评价好不好看，不要推测没看见的内容。表情包就说明是什么梗、想表达什么情绪。",
].join("\n");

/**
 * 描述一张图。失败返回 null —— 调用方把 `[图片]` 原样留着就行。
 *
 * 每个失败分支都留一行 warn：这条链路对用户是静默降级（少一句描述，她照常回话），
 * 但**静默到一点痕迹都不留**就变成没法排查 —— 「她只看到 [图片]」有五种成因，
 * 从开关没开、直链过期、超过 4MB，到视觉模型 429 排队，现象完全一样。
 * 日志只打模型名和原因，不打直链（那是带 rkey 的临时外链，落到日志里没意义）。
 */
async function describeOne(
  ref: ChannelImageRef,
  settings: ImageUnderstandingSettings,
  context: ImageUnderstandingContext,
): Promise<string | null> {
  const fail = (reason: string): null => {
    console.warn(`[vision] 看图失败：${reason}（model=${settings.model}）`);
    return null;
  };
  if (!ref.url) return fail("这条消息没有图片直链（表情包/合并转发常见）");

  let endpoint: URL;
  try {
    endpoint = buildChatCompletionsEndpoint(settings.apiBaseUrl);
  } catch {
    return fail("看图地址无效");
  }

  let image: { buffer: Buffer; mime: string };
  try {
    image = await downloadImage(ref.url);
  } catch (error) {
    return fail(`图片下载失败：${describeDownloadError(error)}`);
  }

  const dataUrl = `data:${image.mime};base64,${image.buffer.toString("base64")}`;
  const body = {
    model: settings.model,
    temperature: 0.2,
    max_tokens: 400,
    messages: [
      { role: "system", content: VISION_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: "这张图里是什么？" },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
  };

  let payload: unknown;
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      redirect: "error",
      headers: { authorization: "Bearer " + settings.apiKey, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(VISION_TIMEOUT_MS),
    });
    // 429 在这里最常见（免费视觉模型排队），而且它和「图看不清」在聊天里长得一模一样。
    if (!response.ok) return fail(`视觉接口返回 HTTP ${response.status}`);
    payload = await response.json();
  } catch (error) {
    const name = error instanceof Error ? error.name : "Error";
    return fail(name === "TimeoutError" || name === "AbortError"
      ? `视觉接口超时（${VISION_TIMEOUT_MS / 1000} 秒）`
      : "视觉接口连不上");
  }

  const usage = readModelUsage(payload);
  if (usage) {
    // 记账失败只写日志，不能把已经拿到的描述丢掉。
    await recordModelUsage({
      kind: "vision",
      model: settings.model,
      usage,
      characterId: context.characterId,
      ...(context.channelBindingId ? { channelBindingId: context.channelBindingId } : {}),
    }).catch(() => undefined);
  }

  const record = asRecord(payload);
  const choices = Array.isArray(record.choices) ? record.choices : [];
  const first = asRecord(choices[0]);
  const message = asRecord(first.message);
  const raw = typeof message.content === "string" ? message.content : "";
  // 思考型视觉模型会「收下图、烧光预算、正文为空」，从外面看也只是 [图片]。
  return sanitizeDescription(raw) ?? fail("视觉模型没返回正文");
}

/** 描述会原样进提示词，所以先压成一行、限长：换行会把一轮群聊的排版搅乱。 */
export function sanitizeDescription(raw: string): string | null {
  const text = raw
    .replace(/\s*\n+\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, DESCRIPTION_MAX_CHARS)
    .trim();
  return text || null;
}

/**
 * 依次描述这一轮里的图。返回与入参等长的数组，失败的位置是 null。
 * 并发跑而不是串行：群里三张图串行会拖到十几秒，那时候这一轮早该回了。
 */
export async function describeImages(
  refs: ChannelImageRef[],
  settings: ImageUnderstandingSettings,
  context: ImageUnderstandingContext,
): Promise<Array<string | null>> {
  const targets = refs.slice(0, MAX_IMAGES_PER_TURN);
  if (!targets.length) return [];
  const settled = await Promise.allSettled(
    targets.map((ref) => describeOne(ref, settings, context)),
  );
  return settled.map((item) => (item.status === "fulfilled" ? item.value : null));
}

/**
 * 把描述填回正文里的 `[图片]` 占位符。
 *
 * 用游标而不是从头 indexOf：描述文本里本身可能包含 `[图片]` 这几个字，
 * 从头找会把后一段又替换一遍，最后得到嵌套的括号。
 */
export function applyImageDescriptions(content: string, descriptions: Array<string | null>): string {
  if (!descriptions.length || !content.includes("[图片]")) return content;
  let text = content;
  let cursor = 0;
  for (const description of descriptions) {
    // 每个结果都必须消费一个原始图片占位符。失败结果保持 [图片]，
    // 但不能跳过它，否则后一张图片的描述会错填到前一张。
    const index = text.indexOf("[图片]", cursor);
    if (index < 0) break;

    const value = description?.trim();
    const replacement = value ? `[图片：${value}]` : "[图片：无法读取]";
    text = text.slice(0, index) + replacement + text.slice(index + "[图片]".length);
    cursor = index + replacement.length;
  }
  return text;
}
