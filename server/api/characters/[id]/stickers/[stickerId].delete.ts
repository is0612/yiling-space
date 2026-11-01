import { createError, getRouterParam } from "h3";
import { requireActorUserId } from "../../../../utils/auth";
import { requireUuid } from "../../../../utils/local-api";
import { getPrisma } from "../../../../utils/prisma";
import { deleteStickerOnQq } from "../../../../utils/qq-sticker-sync";
import { invalidateStickerCache } from "../../../../utils/stickers";

/**
 * 删一张表情包。
 *
 * 「删」现在是**两边一起删**，但本地不真删：
 *   - 行标成 `deletedAt` + `deletedReason: 'local'`，进回收站（图留在磁盘上）；
 *   - 如果这张在 QQ 收藏夹里也有一份，顺手把 QQ 那张删掉。
 *
 * 为什么不硬删：QQ 那边一删、本地连标签一起没了，用户下次再收藏回来还得重新打一遍标。
 * 进回收站还能「恢复」，而恢复后是本地独有的一张，下一次同步会自动推回 QQ —— 意图是连贯的。
 *
 * QQ 删失败不算失败：本地已经进回收站了，下次同步会给「本地删了、QQ 还在」的那些补删一次
 * （见 `planStickerSync` 的 retryDelete）。响应里把 QQ 那边的结果带出去，页面据此提示。
 */
export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const id = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const stickerId = requireUuid(getRouterParam(event, "stickerId") ?? "", "表情包");
  const prisma = getPrisma();

  const existing = await prisma.characterSticker.findFirst({
    where: { id: stickerId, character: { id, ownerId } },
    select: { id: true, fileName: true, qqEmojiId: true, deletedAt: true },
  });
  if (!existing) throw createError({ statusCode: 404, statusMessage: "表情包不存在。" });
  if (existing.deletedAt) throw createError({ statusCode: 409, statusMessage: "这张已经在回收站里了。" });

  await prisma.characterSticker.update({
    where: { id: stickerId },
    data: { deletedAt: new Date(), deletedReason: "local", enabled: false },
  });
  invalidateStickerCache(id);

  const qq = existing.qqEmojiId
    ? await deleteStickerOnQq(id, existing.qqEmojiId)
    : { ok: true as const };

  return { ok: true, qq };
});
