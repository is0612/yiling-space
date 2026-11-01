import { createError, getRouterParam, readBody } from "h3";
import { requireActorUserId } from "../../../../utils/auth";
import { requireUuid } from "../../../../utils/local-api";
import { getPrisma } from "../../../../utils/prisma";
import { stickerUsageError, suggestStickerUsage } from "../../../../utils/sticker-usage";
import { resolveChatModelSettings } from "../../../../utils/chat-model-config";
import { resolveCharacterApiKey } from "../../../../utils/credential-encryption";

/**
 * 添加表情包时的「AI 生成使用场景」。
 *
 * 为什么不是复用 `[stickerId]/usage-suggestion`：这一刻图**还没入库**，没有 id 可查，
 * 所以图得由浏览器直接带过来（`image` 字段，data URL，已经在客户端缩到 200 宽）。
 *
 * 带着图是对的：用户通常先选图、再写名字、然后才想起要一句场景 —— 这时候
 * 模型能同时看到名字和画面，比只凭名字猜准得多。图缩不了（HEIC、解码失败）时
 * 前端就不传，退化成只看名字，接口两条路都认。
 */
const MAX_IMAGE_DATA_URL_CHARS = 400_000;

export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const id = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const prisma = getPrisma();

  const body = await readBody(event).catch(() => null) as { name?: unknown; image?: unknown } | null;
  const name = typeof body?.name === "string" ? body.name.trim().slice(0, 60) : "";

  /**
   * 只收 data URL 形式的图，且限长 —— 这不是上传通道，别让人拿它传几 MB 的图。
   * 超长就当没有图（仍然能按名字生成），比直接 413 更不打断人。
   */
  const rawImage = typeof body?.image === "string" ? body.image.trim() : "";
  const image = rawImage.startsWith("data:image/") && rawImage.length <= MAX_IMAGE_DATA_URL_CHARS
    ? rawImage
    : undefined;

  const character = await prisma.character.findFirst({
    where: { id, ownerId },
    select: { id: true, modelConfig: true },
  });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });

  const chatSettings = resolveChatModelSettings(character.modelConfig);
  const chatApiKey = await resolveCharacterApiKey(character.modelConfig, chatSettings.apiBaseUrl).catch(() => "");

  const result = await suggestStickerUsage({
    name,
    ...(image ? { imageDataUrl: image } : {}),
    context: {
      characterId: id,
      modelConfig: character.modelConfig,
      chatModel: chatSettings.model,
      chatApiBaseUrl: chatSettings.apiBaseUrl,
      chatApiKey,
    },
  });

  if (!result.ok) throw createError(stickerUsageError(result.reason));
  return { usage: result.usage, source: result.source };
});
