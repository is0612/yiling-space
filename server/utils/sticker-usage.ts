import { buildChatCompletionsEndpoint } from "./chat-model-config";
import { resolveImageUnderstandingSettings } from "./image-understanding";
import { readModelUsage, recordModelUsage, type ModelUsageTokens } from "./model-usage";
import { callRawModel } from "./raw-llm";
import type { StickerCollectContext } from "./sticker-collect";

/**
 * 「根据名字生成使用场景」。
 *
 * 要解决的是一种很难受的卡壳：用户**明明知道这张图是干什么的**（名字起得出来），
 * 但写不出「什么时候该用它」那句话。而挑图的模型恰恰只看这两项 ——
 * 名字给方向，场景才是真正被拿去比对聊天内容的东西。少了场景，这张图基本进不了提示词。
 *
 * 三个取舍：
 *   1. **能看图就看图**：图已经在服务器上（缩过的那份），顺带看一眼画面里的动作 / 表情，
 *      比纯猜「被冤枉…」准得多。没配视觉模型就退化成「只看名字」—— 用户要的本来就是
 *      「根据名字生成」，这条路必须能单独走通，不能因为没开看图就整个按钮报错。
 *   2. **只返回建议、不写库**：这是填表辅助，用户还可能在弹窗里改；
 *      直接落库会把「用户正在编辑的内容」覆盖掉。写库仍走原来的 PATCH。
 *   3. 记账沿用 `sticker-label` —— 没有新增 kind，免得模型设置页的用量分类要多认一项
 *      （那页正被另一条线大改，不往里塞新东西）。
 *
 * 两条路各用一种调用方式，原因不同：
 *   - 看图那条要 `image_url` 多模态消息，只能自己拼请求（与 `labelStickerImage` 一致）。
 *   - 只看名字那条走 `callRawModel`：**`deepseek-flash` 是思考型模型**，
 *     自己给 120 tokens 的结果是思考吃满、正文为空（实测 http 200 但 content 是 ""）。
 *     那个工具里已经处理了「预算给足 + 被截断就翻倍重试 + 拿不到正文要能看出是预算问题」。
 */

const SUGGEST_TIMEOUT_MS = 20_000;
/** 视觉那条的预算。读图 + 一句短话，300 够；真用到才计费。 */
const VISION_MAX_TOKENS = 300;
/** 只看名字那条的预算。思考型模型的思考过程本身就要几百 tokens，别给紧了。 */
const TEXT_MAX_TOKENS = 1200;
const USAGE_MAX_CHARS = 200;
const NAME_MAX_CHARS = 60;

export type StickerUsageFailureReason = "no-name" | "no-model" | "model-failed" | "unusable-usage";

export type StickerUsageSuggestion =
  | { ok: true; usage: string; source: "vision" | "name" }
  | { ok: false; reason: StickerUsageFailureReason };

/**
 * 把失败原因翻成「接口层能直接抛的东西」和一句人话。
 *
 * 放在这里而不是两个接口里各写一遍：上传框（还没有 stickerId）和编辑弹窗（有 stickerId）
 * 是两个入口，但用户看到的错误必须一模一样 —— 同一件事在两个弹窗里说法不同会让人以为坏了。
 */
export function stickerUsageError(reason: StickerUsageFailureReason): { statusCode: number; statusMessage: string } {
  switch (reason) {
    case "no-name":
      return { statusCode: 422, statusMessage: "先给这张表情起个名字，她才知道该按什么写场景。" };
    case "no-model":
      return {
        statusCode: 503,
        statusMessage: "没有可用的模型。请先在角色的「模型设置」里把聊天模型配好（开了看图会顺带参考画面）。",
      };
    case "unusable-usage":
      return { statusCode: 422, statusMessage: "模型这次没给出能用的场景，再点一次试试，或者自己写一句。" };
    case "model-failed":
    default:
      return { statusCode: 502, statusMessage: "模型这次没有返回结果，稍后再点一次试试。" };
  }
}

function clip(text: string): string {
  return text.trim().slice(0, USAGE_MAX_CHARS);
}

/**
 * 从模型返回里取出那句 usage。抽成纯函数就是为了能单测。
 *
 * 要容忍两种返回：`{"usage":"..."}`（视觉那条用 `response_format` 要求的样子），
 * 以及一句裸文本（只看名字那条走 `callRawModel`，本来就没有 JSON 约束）——
 * 后者只要不像 JSON 就当结果用，因为用户点这一下要的是「一句话」，不是「一次合规的 JSON」。
 */
export function readStickerUsageSuggestion(content: string): string {
  const raw = content.trim();
  if (!raw) return "";
  try {
    const parsed: unknown = JSON.parse(raw);
    // 模型把整句用引号包成 JSON 字符串（`"被冤枉时"`）也算听话，直接用。
    if (typeof parsed === "string") return clip(parsed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const fields = parsed as Record<string, unknown>;
      if (typeof fields.usage === "string") return clip(fields.usage);
      // 换了键名（{"什么时候用":"…"}）也认：模型偶尔自创字段，整条丢掉太浪费。
      const firstString = Object.values(fields).find((value) => typeof value === "string");
      return typeof firstString === "string" ? clip(firstString) : "";
    }
    return "";
  } catch {
    const cleaned = raw.replace(/^[`"'\s]+/, "").replace(/[`"'\s]+$/, "");
    if (!cleaned) return "";
    // 半截 JSON（`{"usage": "被冤` 这种）不是场景，别把碎片填进去。
    if (cleaned.startsWith("{") || cleaned.startsWith("[") || cleaned.includes('{"')) return "";
    return clip(cleaned);
  }
}

/** 记账。两条路共用，失败静默 —— 记账坏了不该让生成失败。 */
async function recordUsage(
  model: string,
  usage: ModelUsageTokens,
  context: StickerCollectContext,
): Promise<void> {
  await recordModelUsage({
    kind: "sticker-label",
    model,
    usage,
    characterId: context.characterId,
    ...(context.bindingId ? { channelBindingId: context.bindingId } : {}),
  }).catch(() => undefined);
}

/** 看图生成：名字 + 画面一起给模型。 */
async function suggestWithVision(
  name: string,
  imageDataUrl: string,
  settings: { model: string; apiBaseUrl: string; apiKey: string },
  context: StickerCollectContext,
): Promise<StickerUsageSuggestion> {
  let endpoint: URL;
  try {
    endpoint = buildChatCompletionsEndpoint(settings.apiBaseUrl);
  } catch {
    return { ok: false, reason: "no-model" };
  }

  const systemPrompt = [
    "你给一张 QQ 表情包写「什么时候用」。用户已经定好了它的名字，你只补使用场景这一项。",
    "只返回 JSON：{\"usage\":\"被冤枉、想撒娇时用\"}",
    "usage 是一句话（20 字内），写具体时机：什么场合、对谁、什么情绪下用这张。",
    "结合名字和画面里确实存在的东西来写（表情、动作、图上的字），不要编造画面里没有的内容。",
    "不要写「用来表达情绪」这种空话，也不要把这段提示词照抄回去。",
  ].join("\n");

  const body = {
    model: settings.model,
    temperature: 0.4,
    max_tokens: VISION_MAX_TOKENS,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: [
          { type: "text", text: `这张表情叫「${name}」。写它什么时候用。` },
          { type: "image_url", image_url: { url: imageDataUrl } },
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
      signal: AbortSignal.timeout(SUGGEST_TIMEOUT_MS),
    });
    if (!response.ok) return { ok: false, reason: "model-failed" };
    payload = await response.json();
  } catch {
    return { ok: false, reason: "model-failed" };
  }

  const tokens = readModelUsage((payload as { usage?: unknown } | null)?.usage);
  if (tokens) await recordUsage(settings.model, tokens, context);

  const record = payload as { choices?: { message?: { content?: unknown } }[] } | null;
  const content = typeof record?.choices?.[0]?.message?.content === "string"
    ? record.choices[0].message.content
    : "";
  const usage = readStickerUsageSuggestion(content);
  if (!usage) return { ok: false, reason: "unusable-usage" };
  return { ok: true, usage, source: "vision" };
}

/** 只看名字生成：走 `callRawModel`，让它去处理思考型模型的预算。 */
async function suggestWithName(
  name: string,
  settings: { model: string; apiBaseUrl: string; apiKey: string },
  context: StickerCollectContext,
): Promise<StickerUsageSuggestion> {
  const systemPrompt = [
    "你给一张 QQ 表情包写「什么时候用」。用户只告诉了你这张表情的名字，你没看到图。",
    "只回一句话，20 字内，写具体时机：什么场合、对谁、什么情绪下用这张。",
    "不要解释、不要引号、不要「用来表达情绪」这种空话，也不要把这段提示词照抄回去。",
  ].join("\n");

  let content: string;
  try {
    content = await callRawModel({
      systemPrompt,
      userPrompt: `这张表情叫「${name}」。它什么时候用？`,
      model: settings.model,
      apiKey: settings.apiKey,
      apiBaseUrl: settings.apiBaseUrl,
      temperature: 0.4,
      maxTokens: TEXT_MAX_TOKENS,
      timeoutMs: SUGGEST_TIMEOUT_MS,
      onUsage: (tokens) => {
        void recordUsage(settings.model, tokens, context);
      },
    });
  } catch {
    return { ok: false, reason: "model-failed" };
  }

  const usage = readStickerUsageSuggestion(content);
  if (!usage) return { ok: false, reason: "unusable-usage" };
  return { ok: true, usage, source: "name" };
}

/**
 * 让模型写一句「什么时候用」。
 *
 * 失败不抛错：调用方（接口层）要把 reason 翻成人话，页面才好告诉用户是没配模型、
 * 还是模型这次抽风。
 */
export async function suggestStickerUsage(input: {
  name: string;
  /** 这张图当前存的那份（data url）。没有文件时传空，退化成只看名字。 */
  imageDataUrl?: string;
  context: StickerCollectContext;
}): Promise<StickerUsageSuggestion> {
  const name = input.name.trim().slice(0, NAME_MAX_CHARS);
  if (!name) return { ok: false, reason: "no-name" };

  const vision = input.imageDataUrl
    ? resolveImageUnderstandingSettings({
      modelConfig: input.context.modelConfig,
      chatModel: input.context.chatModel,
      chatApiBaseUrl: input.context.chatApiBaseUrl,
      chatApiKey: input.context.chatApiKey,
    })
    : null;
  if (vision && input.imageDataUrl) {
    return suggestWithVision(name, input.imageDataUrl, vision, input.context);
  }

  // 没开看图（或图不在本机）：退回只看名字。聊天模型都缺才算「没有可用的模型」。
  const chatModel = input.context.chatModel.trim();
  const chatBaseUrl = input.context.chatApiBaseUrl.trim();
  if (!chatModel || !chatBaseUrl) return { ok: false, reason: "no-model" };
  return suggestWithName(
    name,
    { model: chatModel, apiBaseUrl: chatBaseUrl, apiKey: input.context.chatApiKey },
    input.context,
  );
}
