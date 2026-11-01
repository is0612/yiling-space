import { createError, getRouterParam } from "h3";
import { requireActorUserId } from "../../../../../../utils/auth";
import { requireUuid } from "../../../../../../utils/local-api";
import { getPrisma } from "../../../../../../utils/prisma";
import { deleteStickerFile, invalidateStickerCache } from "../../../../../../utils/stickers";

/**
 * 从回收站里彻底删掉一张：行和文件一起清，删完找不回来。
 *
 * 只对**已经在回收站里**的执行 —— 在列表上点删除走的是软删（`DELETE /stickers/<id>`），
 * 两边语义分开，就不会出现「以为是回收站，其实直接销毁了」。
 */
export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const id = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const stickerId = requireUuid(getRouterParam(event, "stickerId") ?? "", "表情包");
  const prisma = getPrisma();

  const existing = await prisma.characterSticker.findFirst({
    where: { id: stickerId, character: { id, ownerId } },
    select: { id: true, fileName: true, deletedAt: true },
  });
  if (!existing) throw createError({ statusCode: 404, statusMessage: "表情包不存在。" });
  if (!existing.deletedAt) throw createError({ statusCode: 409, statusMessage: "先把它删进回收站，才能彻底删除。" });

  await prisma.characterSticker.delete({ where: { id: stickerId } });
  await deleteStickerFile(id, existing.fileName);
  invalidateStickerCache(id);
  return { ok: true };
});
