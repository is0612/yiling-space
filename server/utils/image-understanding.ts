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

import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

import { buildChatCompletionsEndpoint, validateChatApiBaseUrl } from "./chat-model-config";
import { readModelUsage, recordModelUsage } from "./model-usage";

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
 *   `VISION_API_KEY` > 聊天模型自己的 Key（同一家服务商时不用配两遍）
 *
 * 回落到聊天模型是刻意的：`deepseek-flash`、`gpt-4o-mini` 这类模型实测都能读图
 * （见 `docs/qq-onebot-adapter.md` 6.1.1），所以"打开开关就能用"不需要再准备第二份凭据。
 * 万一这个模型确实读不了图，调用会失败并按旁路规则静默回落到 `[图片]`。
 */
export function resolveImageUnderstandingSettings(input: {
  modelConfig?: unknown;
  chatModel?: string;
  chatApiBaseUrl?: string;
  chatApiKey?: string;
}): ImageUnderstandingSettings | null {
  const config = asRecord(input.modelConfig);
  if (config.imageUnderstanding !== true) return null;

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

  const apiKey = process.env.VISION_API_KEY?.trim() || input.chatApiKey?.trim() || "";
  if (!apiKey) return null;

  return { model, apiBaseUrl, apiKey };
}

/** 私网/回环 IPv4：这些地址是"本机或内网"，外部 URL 指向它们一律拒绝。 */
function isPrivateIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((item) => !Number.isInteger(item) || item < 0 || item > 255)) return true;
  const [first = 0, second = 0, third = 0] = octets;
  return first === 0
    || first === 10
    || first === 127
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 198 && (second === 18 || second === 19))
    || (first === 192 && second === 0 && (third === 0 || third === 2))
    || first >= 224;
}

function isPrivateIpv6(address: string): boolean {
  const value = address.toLowerCase();
  if (value === "::1" || value === "::") return true;
  // IPv4-mapped（::ffff:10.0.0.1）按内网算：它可以把请求打到私网 IPv4。
  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped?.[1]) return isPrivateIpv4(mapped[1]);
  return value.startsWith("fc")
    || value.startsWith("fd")
    || value.startsWith("fe8")
    || value.startsWith("fe9")
    || value.startsWith("fea")
    || value.startsWith("feb");
}

function unbracket(hostname: string): string {
  return hostname.replace(/^\[/, "").replace(/\]$/, "");
}

/**
 * 下载前的第一道闸：只接受 http(s)，且不能是字面量内网地址。
 * 抛出的是错误，调用方吞掉即可 —— 这张图就当没拿到。
 */
export function assertFetchableImageUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("IMAGE_INVALID_URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("IMAGE_INVALID_PROTOCOL");
  if (url.username || url.password) throw new Error("IMAGE_INVALID_URL");
  const host = unbracket(url.hostname).toLowerCase();
  if (!host) throw new Error("IMAGE_INVALID_URL");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")
    || host.endsWith(".internal") || host.endsWith(".lan") || host === "home.arpa") {
    throw new Error("IMAGE_BLOCKED_HOST");
  }
  const version = isIP(host);
  if (version === 4 && isPrivateIpv4(host)) throw new Error("IMAGE_BLOCKED_HOST");
  if (version === 6 && isPrivateIpv6(host)) throw new Error("IMAGE_BLOCKED_HOST");
  return url;
}

/**
 * 第二道闸：域名可以先过字面量检查，解析出来的地址却可能是内网。
 * DNS 查回来的每一条都得是公网地址，否则整张图都不下载。
 */
export async function assertPublicHost(hostname: string): Promise<void> {
  const host = unbracket(hostname).toLowerCase();
  const version = isIP(host);
  if (version === 4) {
    if (isPrivateIpv4(host)) throw new Error("IMAGE_BLOCKED_HOST");
    return;
  }
  if (version === 6) {
    if (isPrivateIpv6(host)) throw new Error("IMAGE_BLOCKED_HOST");
    return;
  }
  const addresses = await lookup(host, { all: true, verbatim: true });
  if (!addresses.length) throw new Error("IMAGE_DOWNLOAD_FAILED");
  for (const entry of addresses) {
    const blocked = entry.family === 4 ? isPrivateIpv4(entry.address) : isPrivateIpv6(entry.address);
    if (blocked) throw new Error("IMAGE_BLOCKED_HOST");
  }
}

export async function downloadImage(rawUrl: string): Promise<{ buffer: Buffer; mime: string }> {
  const url = assertFetchableImageUrl(rawUrl);
  await assertPublicHost(url.hostname);

  let response: Response;
  try {
    response = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      headers: { accept: "image/*" },
    });
  } catch {
    throw new Error("IMAGE_DOWNLOAD_FAILED");
  }
  if (!response.ok) throw new Error("IMAGE_HTTP_" + response.status);

  // 重定向之后可能换了 host：最终地址要再过一遍同样的检查，别让 302 绕开白名单。
  try {
    await assertPublicHost(new URL(response.url).hostname);
  } catch {
    throw new Error("IMAGE_BLOCKED_HOST");
  }

  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES) throw new Error("IMAGE_TOO_LARGE");

  const mime = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!mime.startsWith("image/")) throw new Error("IMAGE_NOT_IMAGE");

  let buffer: Buffer;
  try {
    buffer = Buffer.from(await response.arrayBuffer());
  } catch {
    throw new Error("IMAGE_DOWNLOAD_FAILED");
  }
  if (buffer.byteLength > MAX_IMAGE_BYTES) throw new Error("IMAGE_TOO_LARGE");
  return { buffer, mime };
}

const VISION_PROMPT = [
  "你在帮一个 QQ 群里的 AI 角色看群友发的图。",
  "用中文写 2-4 句，只说画面里确实存在的东西：主体、动作或场景、图里出现的文字（原样抄出来）、整体氛围。",
  "不要开场白，不要评价好不好看，不要推测没看见的内容。表情包就说明是什么梗、想表达什么情绪。",
].join("\n");

/**
 * 描述一张图。失败返回 null —— 调用方把 `[图片]` 原样留着就行。
 */
async function describeOne(
  ref: ChannelImageRef,
  settings: ImageUnderstandingSettings,
  context: ImageUnderstandingContext,
): Promise<string | null> {
  if (!ref.url) return null;

  let endpoint: URL;
  try {
    endpoint = buildChatCompletionsEndpoint(settings.apiBaseUrl);
  } catch {
    return null;
  }

  let image: { buffer: Buffer; mime: string };
  try {
    image = await downloadImage(ref.url);
  } catch {
    return null;
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
    if (!response.ok) return null;
    payload = await response.json();
  } catch {
    return null;
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
  return sanitizeDescription(raw);
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
    const value = description?.trim();
    if (!value) continue;
    const index = text.indexOf("[图片]", cursor);
    if (index < 0) break;
    const replacement = `[图片：${value}]`;
    text = text.slice(0, index) + replacement + text.slice(index + "[图片]".length);
    cursor = index + replacement.length;
  }
  return text;
}
