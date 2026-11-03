import { createHash } from "node:crypto";
import { buildChatCompletionsEndpoint } from "./chat-model-config";
import { downloadImage, resolveVisionSettingsForCharacter } from "./image-understanding";
import { parseJsonLoose } from "./loose-json";
import { readModelUsage, recordModelUsage } from "./model-usage";
import { normalizeStickerImage } from "./sticker-image";
import {
  invalidateStickerCache,
  resolveStickerExtension,
  saveStickerFile,
  deleteStickerFile,
  toStickerDto,
} from "./stickers";

/**
 * 「偷表情包」：看到群友发图/表情，判断这张值得收，就存进她自己的表情库，
 * 再用视觉模型自动补上「名字 + 什么时候用」。
 *
 * 设计边界（别越界）：
 *   1. **只收群聊里的图**，且不看她自己（ASSISTANT）发的 —— 偷自己的图没有意义，还容易无限循环。
 *   2. 复用看图旁路的 `downloadImage`（rkey 时效 + 公网白名单 + 4MB 上限），不重写一套下载。
 *      拿不到 url 的商城表情包（`marketface`）本来就没有图片本体，自然收不了。
 *   3. **按内容 hash 去重**：群里一张图被转来转去，只收第一次；她自己库里的图也不再重复偷。
 *   4. 打标复用视觉模型配置（不配 `VISION_MODEL` / 没开看图就完全不动），但提示词换成
 *      「给表情包起名 + 写使用场景」输出 JSON，而不是看图旁路那段画面描述。
 *   5. **起不出名字就不收**：名字是模型挑图的唯一依据，`收藏的表情` 这种兜底名等于废图，
 *      存进去只是白占名额。没配视觉模型时同理，整条自动收图等于关着。
 *      模型判定「这不是表情包」（聊天截图 / 长截图 / 照片）也一样直接丢 —— 那是噪声，不是表情。
 *   6. 整条链路失败都静默：收图是锦上添花，不能让一轮群聊因此变成错误。
 */

export type StickerCollectCandidate = {
  /** 图片直链（有时效，必须当场下载）。 */
  url: string;
  /** 表情包常带的一句梗说明，能帮视觉模型起名。 */
  summary?: string;
};

export type StickerCollectContext = {
  characterId: string;
  bindingId?: string;
  modelConfig: unknown;
  chatModel: string;
  chatApiBaseUrl: string;
  chatApiKey: string;
};

const MAX_COLLECT_PER_TURN = 1;
const LABEL_TIMEOUT_MS = 20_000;
const LABEL_MAX_TOKENS = 200;

/** 角色是否开了「自动收图」。默认关：一开就会在群里为每张图花钱，不能静默上线。 */
export function isStickerAutoCollectEnabled(modelConfig: unknown): boolean {
  const record = modelConfig && typeof modelConfig === "object" && !Array.isArray(modelConfig)
    ? modelConfig as Record<string, unknown>
    : {};
  return record.stickerAutoCollect === true;
}

/** 图的 SHA-256。用内容而不是 url：同一张图换了直链还是同一张。 */
function hashOf(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * 这些名字等于「没起名」。模型偶尔会偷懒直接回「表情」「表情包」，
 * 存下来就是占着额度、又永远挑不中的图 —— 名字里没有任何可判断的信息。
 */
const GENERIC_NAMES = new Set(["表情", "表情包", "图片", "收藏的表情", "未知", "无", "表情图片", "一张图"]);

function isUsableStickerName(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return false;
  return !GENERIC_NAMES.has(trimmed);
}

/**
 * 打标结果。用「带原因」的联合类型而不是 `null` —— 收图时两者都是「不收」，
 * 但列表里的「重新识别」要把原因翻译成人话告诉用户（是不是截图、还是模型这次抽风）。
 */
export type StickerLabelResult =
  | { ok: true; name: string; usage: string }
  | { ok: false; reason: "no-vision" | "model-failed" | "not-a-sticker" | "unusable-name" };

/**
 * 解析模型返回的这段 JSON。抽成纯函数是为了能单测 —— 真调模型太贵也太慢，
 * 而这里恰恰是最容易出错的地方（skip 判定、泛称名字、非 JSON）。
 *
 * 用宽松解析，不用裸 `JSON.parse`。
 *
 * `response_format: json_object` 只是请求、不是保证 —— 视觉模型最常见的两种坏输出是
 * 套一层 ```json 围栏、或前面先写「好的，这是结果：」，括号里的内容其实全对。
 * 裸解会把这两种都判成 `model-failed`，表现就是「明明配了图片模型，一张也收不到」，
 * 而失败那一步是静默的，用户根本查不出原因。
 * 项目里其它 LLM 出口（chat-reply / proactive / bili / memory-ai）早就走 `parseJsonLoose` 了，
 * 只有这里漏了 —— CLAUDE.md 里写死的那条「一律走 parseJsonLoose，不许裸 JSON.parse」。
 */
export function readStickerLabel(content: string): StickerLabelResult {
  const parsed = parseJsonLoose(content, { expect: "object" }) as
    | { name?: unknown; usage?: unknown; skip?: unknown }
    | null;
  if (!parsed) return { ok: false, reason: "model-failed" };
  // 模型说「这不是表情包」：聊天截图、长截图、随手拍的照片都落在这里。
  if (parsed.skip === true) return { ok: false, reason: "not-a-sticker" };
  const name = typeof parsed.name === "string" ? parsed.name.trim().slice(0, 60) : "";
  const usage = typeof parsed.usage === "string" ? parsed.usage.trim().slice(0, 200) : "";
  if (!isUsableStickerName(name)) return { ok: false, reason: "unusable-name" };
  return { ok: true, name, usage };
}

/**
 * 让视觉模型看一张图，给出「名字 + 使用场景」，或者判定「这不是表情包」。
 *
 * 为什么要有 skip：群里转的图里有相当一部分是**别人的聊天截图、长截图、随手拍的照片**。
 * 这些图进了库等于噪声 —— 模型只能硬给它起个名字，之后又永远挑不中，
 * 用户还得手动删。与其收进来再删，不如在成本最低的这一步就丢掉。
 *
 * 但**默认仍然是收**：提示词写的是「只有明显不能当表情用时才 skip」，
 * 拿不准就正常起名 —— 误杀一张好图比多收一张差图更让人难受。
 *
 * 失败也返回结果而不是抛错：表情包不是主流程，出错不该把上传 / 收图 / 页面整条打断。
 */
export async function labelStickerImage(
  dataUrl: string,
  summary: string,
  context: StickerCollectContext,
): Promise<StickerLabelResult> {
  // 打标和「看图」共用同一套配置（含角色单独配的视觉 Key），只是提示词不同。
  const settings = await resolveVisionSettingsForCharacter({
    modelConfig: context.modelConfig,
    chatModel: context.chatModel,
    chatApiBaseUrl: context.chatApiBaseUrl,
    chatApiKey: context.chatApiKey,
  });
  if (!settings) {
    /**
     * 打标跟着「看群里的图」走（`resolveVisionSettingsForCharacter` 默认要求开关打开），
     * 所以这里为空有两种原因：开关没开，或地址/Key 配不全。
     * 这一条以前完全静默 —— 它是「勾了偷表情包却一张也收不到」最常见的原因，
     * 配了图片模型的人也会栽在这（模型配好了，开关没开）。
     */
    console.warn(
      `[sticker] 没有可用的视觉配置（character=${context.characterId}）：先确认「看群里的图」开着，再看图片模型的地址与 Key`,
    );
    return { ok: false, reason: "no-vision" };
  }

  let endpoint: URL;
  try {
    endpoint = buildChatCompletionsEndpoint(settings.apiBaseUrl);
  } catch {
    console.warn(
      `[sticker] 图片模型地址无效（character=${context.characterId} model=${settings.model}）：${settings.apiBaseUrl}`,
    );
    return { ok: false, reason: "no-vision" };
  }

  const hint = summary.trim() ? `（图自带的梗说明：${summary.trim().slice(0, 80)}）` : "";
  const body = {
    model: settings.model,
    temperature: 0.2,
    max_tokens: LABEL_MAX_TOKENS,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: [
          "你给一张 QQ 表情包起名并写使用场景，或者判定它根本不是表情包。只返回 JSON，两种情况之一：",
          "① 能当表情用（梗图 / 表情 / 动图）:{\"name\":\"委屈\",\"usage\":\"被冤枉、想撒娇时用\"}",
          "② 明显不是表情包:{\"skip\":true}",
          "name 是简短的中文名（2-6 个字，写成情绪或动作词，如「委屈」「拍桌笑」「比心」），不要编号、不要带「表情包」三个字。",
          "usage 是一句话（20 字内），写「什么时候用这张」，如「被冤枉、想撒娇时」。",
          "只有这张图**明显不能当表情用**时才选 ②：聊天记录截图、长截图、网页或文字截图、带大段文字的信息图、随手拍的照片。",
          "拿不准的时候一律选 ①，正常起名 —— 宁可名字普通，也不要把能用的表情丢掉。",
          "只看图里确实存在的东西，不要推测。名字和 usage 不要照抄这段提示词。",
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          { type: "text", text: `给这张图起名并写使用场景；如果它明显不是表情包，返回 skip。${hint}` },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
  };

  /**
   * 发一次打标请求。`jsonMode=false` 只用于「服务商不认 response_format」时的重试：
   * 传 `undefined` 让 JSON.stringify 直接把这个键省掉。
   */
  const sendLabel = (jsonMode: boolean): Promise<Response> => fetch(endpoint, {
    method: "POST",
    redirect: "error",
    headers: { authorization: "Bearer " + settings.apiKey, "content-type": "application/json" },
    body: JSON.stringify(jsonMode ? body : { ...body, response_format: undefined }),
    signal: AbortSignal.timeout(LABEL_TIMEOUT_MS),
  });

  let payload: unknown;
  try {
    let response = await sendLabel(true);
    if (response.status === 400) {
      /**
       * 400 最常见的一种成因：服务商不认 `response_format: json_object`（自建网关、
       * 老版本 vLLM、部分中转都这样）。「测试看图」不带这个字段，所以
       * **「测试通过」完全不代表打标能过** —— 这正是「配了图片模型还是偷不到」的隐藏分叉。
       * 去掉它重试一次：格式本来就有提示词 + `parseJsonLoose` 兜底，围栏和前缀废话都救得回来。
       */
      const raw = await response.text().catch(() => "");
      if (/response_format|json_object|json\s*mode/i.test(raw)) {
        console.warn(
          `[sticker] 服务商不认 response_format，去掉后重试（character=${context.characterId} model=${settings.model}）`,
        );
        response = await sendLabel(false);
      } else {
        console.warn(
          `[sticker] 打标 HTTP 400（character=${context.characterId} model=${settings.model}）：${raw.replace(/\s+/g, " ").slice(0, 200)}`,
        );
        return { ok: false, reason: "model-failed" };
      }
    }
    if (!response.ok) {
      /**
       * 状态码与正文必须留痕，这一步以前是完全静默的。
       *
       * 401/403 是这把 Key 没有该模型的权限（它和对话 Key 是分开存的，跨服务商只换模型名必踩）；
       * 404 是模型名或地址写错；429 是限流。这三种在「偷不到」上长得一模一样，只有原文能分清。
       */
      const raw = await response.text().catch(() => "");
      console.warn(
        `[sticker] 打标 HTTP ${response.status}（character=${context.characterId} model=${settings.model}）：${raw.replace(/\s+/g, " ").slice(0, 200)}`,
      );
      return { ok: false, reason: "model-failed" };
    }
    payload = await response.json();
  } catch (error) {
    console.warn(
      `[sticker] 打标请求失败（character=${context.characterId} model=${settings.model}）：${error instanceof Error ? error.message : String(error)}`,
    );
    return { ok: false, reason: "model-failed" };
  }

  const usage = (payload as { usage?: unknown } | null)?.usage;
  const tokens = readModelUsage(usage);
  if (tokens) {
    await recordModelUsage({
      kind: "sticker-label",
      model: settings.model,
      usage: tokens,
      characterId: context.characterId,
      ...(context.bindingId ? { channelBindingId: context.bindingId } : {}),
    }).catch(() => undefined);
  }

  const record = payload as {
    choices?: Array<{ message?: { content?: unknown }; finish_reason?: string }>;
  } | null;
  const content = typeof record?.choices?.[0]?.message?.content === "string"
    ? record.choices[0].message.content
    : "";
  if (!content.trim()) {
    /**
     * 200 但没有正文：思考模型最典型的表现 —— 200 tokens 先被思考过程吃光，`finish_reason=length`。
     * 这和「模型配错了」在现象上一模一样（都不收图），解法却完全不同：
     * 那种要换一个不思考的视觉模型，而不是去翻 Key 和地址。所以把 finish_reason 打出来。
     */
    const finishReason = record?.choices?.[0]?.finish_reason ?? "";
    console.warn(
      `[sticker] 打标返回空正文（character=${context.characterId} model=${settings.model} finish=${finishReason || "?"}）：${finishReason === "length" ? "输出预算被思考过程吃光了，换一个不思考的视觉模型" : "接口收下了图但没有正文"}`,
    );
    return { ok: false, reason: "model-failed" };
  }
  const result = readStickerLabel(content);
  if (!result.ok) {
    // 起不出名字 / 判成不是表情包：把模型原文截一段出来。只看「没收」分不清是它偷懒回了个
    // 「表情包」这种泛称，还是它压根没按 JSON 回 —— 两种的修法完全不同。
    console.warn(
      `[sticker] 打标未通过（${result.reason}，character=${context.characterId} model=${settings.model}）：${content.replace(/\s+/g, " ").slice(0, 160)}`,
    );
  }
  return result;
}

/**
 * 收一张图进角色表情库。返回新增的 DTO，失败返回 null。
 *
 * 去重分两层：先查这个角色有没有 `contentHash` 相同的图（偷过的不再偷），
 * 再落库前用唯一性兜底 —— 并发时两条同 hash 的记录可能同时通过查询，靠再次校验挡住。
 */
export async function collectSticker(
  candidate: StickerCollectCandidate,
  context: StickerCollectContext,
): Promise<ReturnType<typeof toStickerDto> | null> {
  if (!candidate.url) return null;

  let image: { buffer: Buffer; mime: string };
  try {
    image = await downloadImage(candidate.url);
  } catch (error) {
    /**
     * 下载失败的原因是定值（`IMAGE_TOO_LARGE` / `IMAGE_BLOCKED_HOST` / `IMAGE_HTTP_403` …），
     * 直链还带 rkey、有时效。出了事只有这行日志能证明是「图根本没拿到」，
     * 而不是「模型不收」—— 两种在用户那边都是「偷不到」。
     */
    console.warn(
      `[sticker] 下载失败（${error instanceof Error ? error.message : "?"}，character=${context.characterId}）：${candidate.url.slice(0, 100)}`,
    );
    return null;
  }

  const extension = resolveStickerExtension(image.mime);
  if (!extension) {
    // QQ 图床偶尔给 `image/jpg` 这种非标准值，而映射表里只有 png/jpeg/gif/webp。
    // 不收是对的（存下来也发不出去），但要让人看得出是「类型不认」，别和「模型不收」混在一起。
    console.warn(`[sticker] 不认识的图片类型 ${image.mime}（character=${context.characterId}），跳过`);
    return null;
  }

  const contentHash = hashOf(image.buffer);
  const { getPrisma } = await import("./prisma");
  const prisma = getPrisma();

  const existing = await prisma.characterSticker.findFirst({
    where: { characterId: context.characterId, contentHash },
    select: { id: true },
  });
  if (existing) {
    // 群里同一张表情被转来转去很常见，这条不算故障，但也要留痕 ——
    // 否则「一直在发图却一直没新增」会被误读成收图坏了。
    console.log(`[sticker] 这张已经收过了（character=${context.characterId} hash=${contentHash.slice(0, 8)}），跳过`);
    return null;
  }

  /**
   * 缩到宽 200 再存：QQ 按图片原始像素显示，群里偷来的图常常 1000px 以上，
   * 存原件就是存一张「发出去占满一屏」的巨图。
   *
   * 用缩好的这张去打标也有好处：200 宽的 base64 小一大截，视觉请求更快更便宜，
   * 而判断「这张适合什么时候用」看 200 宽完全够。
   */
  const normalized = await normalizeStickerImage(image.buffer, image.mime);
  const storedImage = normalized?.resized ? normalized.buffer : image.buffer;

  const dataUrl = `data:${image.mime};base64,${storedImage.toString("base64")}`;
  const label = await labelStickerImage(dataUrl, candidate.summary ?? "", context);
  /**
   * 起不出名字就不收；模型说「这不是表情包」更不收。
   *
   * 以前用「收藏的表情」兜底存下来，结果库里攒了几张既没名字线索、也没使用场景的图：
   * 提示词里模型只看到「收藏的表情 / usage 空」，根本判断不出什么时候该用，
   * 等于白占一个名额（实测 25 张里有 3 张是这种）。识别不了就别进库 ——
   * 用户要的是「她的表情包」，不是「一堆图」。
   *
   * `not-a-sticker` 是最常见的一种：群里的图有相当一部分是别人的聊天截图、
   * 长截图、随手拍的照片，收进来只会是噪声。
   */
  if (!label.ok) {
    // 原因已经在 `labelStickerImage` 里那行「打标未通过」打过了，这里不重复刷屏。
    return null;
  }
  const name = label.name;
  const usage = label.usage;

  const fileName = await saveStickerFile(context.characterId, extension, storedImage);
  let row;
  try {
    row = await prisma.characterSticker.create({
      data: {
        characterId: context.characterId,
        name,
        usage,
        fileName,
        mimeType: image.mime,
        sizeBytes: storedImage.byteLength,
        contentHash,
        source: "collected",
      },
    });
  } catch (error) {
    // 并发下撞了唯一约束或别的写入错误：删掉刚落的文件，当没收下。
    await deleteStickerFile(context.characterId, fileName);
    console.warn(
      `[sticker] 入库失败（character=${context.characterId}）：${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
  invalidateStickerCache(context.characterId);
  console.log(`[sticker] 收下了「${name}」（character=${context.characterId}）`);
  return toStickerDto(row);
}

/**
 * 从一轮群聊的图里挑要收的。当前策略：收第一张能拿到的图，一轮最多一张。
 * 不调模型判断「值不值得收」——那张图已经在提示词里了，这里只负责把图本体存下来。
 */
export async function collectStickersFromTurn(
  candidates: readonly StickerCollectCandidate[],
  context: StickerCollectContext,
): Promise<void> {
  if (!isStickerAutoCollectEnabled(context.modelConfig)) return;
  for (const candidate of candidates.slice(0, MAX_COLLECT_PER_TURN)) {
    await collectSticker(candidate, context);
  }
}
