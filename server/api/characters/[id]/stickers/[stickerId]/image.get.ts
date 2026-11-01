import { createError, getRouterParam, setHeader } from "h3";
import { requireActorUserId } from "../../../../../utils/auth";
import { requireUuid } from "../../../../../utils/local-api";
import { getPrisma } from "../../../../../utils/prisma";
import { readStickerFile } from "../../../../../utils/stickers";

/**
 * 取表情包图片本体，给页面显示缩略图。
 *
 * 必须走接口而不是静态目录：图片在 `.data/` 下（不可被 Web 直接访问），
 * 而它属于角色的私人素材 —— 顺手放开等于把用户的图公开出去。
 */
export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const id = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const stickerId = requireUuid(getRouterParam(event, "stickerId") ?? "", "表情包");
  const prisma = getPrisma();

  const existing = await prisma.characterSticker.findFirst({
    where: { id: stickerId, character: { id, ownerId } },
    select: { id: true, fileName: true, mimeType: true },
  });
  if (!existing) throw createError({ statusCode: 404, statusMessage: "表情包不存在。" });

  const file = await readStickerFile(id, existing.fileName);
  // 换电脑只搬了库、没搬 .data 时就会走到这里：报 404 而不是 500，页面显示成「图片缺失」。
  if (!file) throw createError({ statusCode: 404, statusMessage: "图片文件不在本机（可能未随数据迁移）。" });

  setHeader(event, "content-type", existing.mimeType || "image/png");
  setHeader(event, "cache-control", "private, max-age=300");
  return file;
});
