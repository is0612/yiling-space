import { createError, getRouterParam } from "h3";
import { requireActorUserId } from "../../../../../utils/auth";
import { requireUuid } from "../../../../../utils/local-api";
import { getPrisma } from "../../../../../utils/prisma";
import { labelStickerImage } from "../../../../../utils/sticker-collect";
import { invalidateStickerCache, readStickerFile, toStickerDto } from "../../../../../utils/stickers";
import { resolveChatModelSettings } from "../../../../../utils/chat-model-config";
import { resolveCharacterApiKey } from "../../../../../utils/credential-encryption";

/**
 * 让视觉模型**再看一次**这张图，重写名字与使用场景。
 *
 * 为什么需要：第一次打标经常不准 —— 群里的图没有上下文，模型只凭画面猜；
 * 动图（只看到某一帧）、抽象梗图、带字的图尤其容易起错名字。用户宁可让她再看一次，
 * 也不想手打一遍。
 *
 * 三个取舍：
 *   1. **直接写库并返回新 DTO**，不返回「建议值让前端再提交一次」：用户点这一下就是
 *      「按新的来」，多一次确认只是多一次点击；不满意还有「编辑」按钮兜底。
 *   2. 模型说「这不是表情包」时**不改动数据**，只回 `skipped` + 一句人话。
 *      改名字是副作用，判断不了就别动。
 *   3. 用的是这张图**当前存的那份**（已缩到宽 200），不是原图 —— 那才是她真正会发出去的图，
 *      打标就该按它来。（原图在 `.data/sticker-originals/`，只用于将来重缩。）
 */
export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const id = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const stickerId = requireUuid(getRouterParam(event, "stickerId") ?? "", "表情包");
  const prisma = getPrisma();

  const character = await prisma.character.findFirst({
    where: { id, ownerId },
    select: { id: true, modelConfig: true },
  });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });

  const sticker = await prisma.characterSticker.findFirst({
    where: { id: stickerId, characterId: id },
    select: { id: true, fileName: true, mimeType: true },
  });
  if (!sticker) throw createError({ statusCode: 404, statusMessage: "表情包不存在。" });

  const file = await readStickerFile(id, sticker.fileName);
  if (!file) throw createError({ statusCode: 404, statusMessage: "图片文件不在本机（可能未随数据迁移）。" });

  const chatSettings = resolveChatModelSettings(character.modelConfig);
  const chatApiKey = await resolveCharacterApiKey(character.modelConfig, chatSettings.apiBaseUrl).catch(() => "");

  const dataUrl = `data:${sticker.mimeType || "image/png"};base64,${file.toString("base64")}`;
  const label = await labelStickerImage(dataUrl, "", {
    characterId: id,
    modelConfig: character.modelConfig,
    chatModel: chatSettings.model,
    chatApiBaseUrl: chatSettings.apiBaseUrl,
    chatApiKey,
  });

  if (!label.ok) {
    // 模型判断「这不是表情包」：不改数据，把判断交回给用户（该删就删）。
    if (label.reason === "not-a-sticker") {
      return {
        skipped: true,
        reason: label.reason,
        message: "模型判断这张不像表情包（可能是聊天截图、长截图或照片），名字没有改。要不要直接删掉？",
      };
    }
    if (label.reason === "no-vision") {
      throw createError({
        statusCode: 503,
        statusMessage: "没有可用的视觉模型。请在角色的「模型设置 → 看图」里打开开关，并确认视觉模型已配置。",
      });
    }
    if (label.reason === "unusable-name") {
      throw createError({
        statusCode: 422,
        statusMessage: "模型这次只给出一个没有信息量的名字（比如「表情包」），这张可能需要你自己写。",
      });
    }
    throw createError({ statusCode: 502, statusMessage: "视觉模型这次没有返回结果，稍后再点一次试试。" });
  }

  const row = await prisma.characterSticker.update({
    where: { id: stickerId },
    data: { name: label.name, usage: label.usage },
  });
  invalidateStickerCache(id);
  return { skipped: false, sticker: toStickerDto(row) };
});
