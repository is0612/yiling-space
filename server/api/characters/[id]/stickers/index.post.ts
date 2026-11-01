import { createError, getRouterParam, readMultipartFormData } from "h3";
import { requireActorUserId } from "../../../../utils/auth";
import { readTrimmedString, requireUuid } from "../../../../utils/local-api";
import { getPrisma } from "../../../../utils/prisma";
import { pushStickerToQq } from "../../../../utils/qq-sticker-sync";
import {
  MAX_STICKER_BYTES,
  invalidateStickerCache,
  resolveStickerExtension,
  saveStickerFile,
  stickerMimeForExtension,
  toStickerDto,
} from "../../../../utils/stickers";
import { normalizeStickerImage } from "../../../../utils/sticker-image";

/**
 * 上传一张表情包。
 *
 * multipart 而不是 JSON + base64：图片是二进制，硬塞进 JSON 要多花三分之一体积，
 * 还得自己拆边界。字段只有三个：file（图）、name（她看到的名字）、usage（什么时候用）。
 */
export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const id = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const prisma = getPrisma();
  const character = await prisma.character.findFirst({ where: { id, ownerId }, select: { id: true } });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });

  const form = await readMultipartFormData(event).catch(() => null);
  if (!form?.length) throw createError({ statusCode: 400, statusMessage: "没有收到上传内容。" });

  const filePart = form.find((part) => part.name === "file");
  const field = (name: string): string => {
    const part = form.find((item) => item.name === name);
    return part?.data ? Buffer.from(part.data).toString("utf8") : "";
  };
  if (!filePart?.data?.length) throw createError({ statusCode: 400, statusMessage: "请先选择一张图片。" });
  if (filePart.data.length > MAX_STICKER_BYTES) {
    throw createError({ statusCode: 413, statusMessage: `图片不能超过 ${Math.floor(MAX_STICKER_BYTES / 1024 / 1024)}MB。` });
  }

  // 扩展名只从 mime 或原始文件名推断，**并且只用于拼自己生成的文件名**——
  // 客户端传来的名字永远不进路径。
  const extension = resolveStickerExtension(filePart.type, field("filename"));
  if (!extension) throw createError({ statusCode: 415, statusMessage: "只支持 PNG / JPG / GIF / WebP 图片。" });

  const name = readTrimmedString(field("name"), "表情包名字", 60, { required: true });
  const usage = readTrimmedString(field("usage"), "使用场景", 200);

  // 宽于 200 的图先等比缩小：QQ 按原始像素显示，1500px 的图发出去是一条占满屏的巨图。
  // 缩不了（解不开）就存原件 —— 上传不该因为「图太大」而失败。
  const mimeType = stickerMimeForExtension(extension);
  const normalized = await normalizeStickerImage(filePart.data, mimeType);
  const stored = normalized?.resized ? normalized.buffer : filePart.data;
  if (stored.length > MAX_STICKER_BYTES) {
    throw createError({ statusCode: 413, statusMessage: `图片不能超过 ${Math.floor(MAX_STICKER_BYTES / 1024 / 1024)}MB。` });
  }

  const fileName = await saveStickerFile(id, extension, stored);
  const row = await prisma.characterSticker.create({
    data: {
      characterId: id,
      name,
      usage,
      fileName,
      mimeType: normalized?.mimeType || mimeType,
      sizeBytes: stored.length,
    },
  });
  invalidateStickerCache(id);

  /**
   * 顺手收藏到 QQ。
   *
   * 用户要的是「两边是同一批表情」，那本地加一张就该在 QQ 里也出现一张 —— 还要再点一次同步
   * 才知道能推上去就太绕了。推失败不影响本地已经加好（下次同步会补推），
   * 所以结果放 `qq` 里给页面提示，不抛错。
   */
  const qq = await pushStickerToQq(id, row.id).catch((error: unknown) => ({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }));
  if (!qq.ok) return { ...toStickerDto(row), qq };

  const fresh = await prisma.characterSticker.findUnique({ where: { id: row.id } });
  return { ...toStickerDto(fresh ?? row), qq };
});
