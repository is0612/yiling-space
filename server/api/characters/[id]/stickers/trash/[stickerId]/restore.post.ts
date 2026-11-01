import { createError, getRouterParam } from "h3";
import { requireActorUserId } from "../../../../../../utils/auth";
import { requireUuid } from "../../../../../../utils/local-api";
import { getPrisma } from "../../../../../../utils/prisma";
import { invalidateStickerCache, toStickerDto } from "../../../../../../utils/stickers";

/**
 * 从回收站恢复一张。
 *
 * 恢复只动本地：如果这张是「QQ 那边删了」才进回收站的，恢复后它又是一张只有本地有的表情，
 * 下次同步会把它重新推回 QQ 收藏夹 —— 这正是用户期望的「我说了算」。
 */
export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const id = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const stickerId = requireUuid(getRouterParam(event, "stickerId") ?? "", "表情包");
  const prisma = getPrisma();

  const existing = await prisma.characterSticker.findFirst({
    where: { id: stickerId, character: { id, ownerId } },
    select: { id: true, deletedAt: true },
  });
  if (!existing) throw createError({ statusCode: 404, statusMessage: "表情包不存在。" });
  if (!existing.deletedAt) throw createError({ statusCode: 409, statusMessage: "这张没有在回收站里。" });

  const row = await prisma.characterSticker.update({
    where: { id: stickerId },
    data: { deletedAt: null, deletedReason: null, enabled: true },
  });
  invalidateStickerCache(id);
  return toStickerDto(row);
});
