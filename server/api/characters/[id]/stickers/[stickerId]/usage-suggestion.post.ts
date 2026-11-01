import { createError, getRouterParam, readBody } from "h3";
import { requireActorUserId } from "../../../../../utils/auth";
import { requireUuid } from "../../../../../utils/local-api";
import { getPrisma } from "../../../../../utils/prisma";
import { readStickerFile } from "../../../../../utils/stickers";
import { stickerUsageError, suggestStickerUsage } from "../../../../../utils/sticker-usage";
import { resolveChatModelSettings } from "../../../../../utils/chat-model-config";
import { resolveCharacterApiKey } from "../../../../../utils/credential-encryption";

/**
 * 给「什么时候用」这一栏生成一句话。
 *
 * 为什么要有：用户常常知道这张图是干什么的（名字起得出来），但写不出场景那句话。
 * 而挑图的模型真正比对的是 usage —— 空着等于这张图永远轮不上。
 *
 * 两个取舍：
 *   1. **不写库，只回建议**。这是编辑弹窗里的填表辅助，用户可能还要改；
 *      保存仍然走原来的 `PATCH /stickers/{stickerId}`，一次点击不该顺手改数据。
 *   2. 用的是表单里**当前**填的名字（`body.name`），不是库里那个 —— 用户往往先改了名字
 *      才想起来点这个按钮，拿旧名字生成会明显对不上。名字为空时退回库里存的那个。
 */
export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const id = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const stickerId = requireUuid(getRouterParam(event, "stickerId") ?? "", "表情包");
  const prisma = getPrisma();

  const body = await readBody(event).catch(() => null) as { name?: unknown } | null;
  const typedName = typeof body?.name === "string" ? body.name.trim().slice(0, 60) : "";

  const character = await prisma.character.findFirst({
    where: { id, ownerId },
    select: { id: true, modelConfig: true },
  });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });

  const sticker = await prisma.characterSticker.findFirst({
    where: { id: stickerId, characterId: id },
    select: { id: true, name: true, fileName: true, mimeType: true },
  });
  if (!sticker) throw createError({ statusCode: 404, statusMessage: "表情包不存在。" });

  const name = typedName || sticker.name;
  if (!name.trim()) {
    throw createError({ statusCode: 422, statusMessage: "先给这张表情起个名字，她才知道该按什么写场景。" });
  }

  // 图不在本机（数据迁移没带过来）不致命：还能只看名字生成。
  const file = await readStickerFile(id, sticker.fileName).catch(() => null);
  const imageDataUrl = file
    ? `data:${sticker.mimeType || "image/png"};base64,${file.toString("base64")}`
    : undefined;

  const chatSettings = resolveChatModelSettings(character.modelConfig);
  const chatApiKey = await resolveCharacterApiKey(character.modelConfig, chatSettings.apiBaseUrl).catch(() => "");

  const result = await suggestStickerUsage({
    name,
    ...(imageDataUrl ? { imageDataUrl } : {}),
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
