import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { createError, getRouterParam, setHeader } from "h3";
import { requireActorUserId } from "../../../../../utils/auth";
import { requireUuid } from "../../../../../utils/local-api";
import { dataPath } from "../../../../../utils/data-dir";
import { getPrisma } from "../../../../../utils/prisma";

export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const photoId = requireUuid(getRouterParam(event, "photoId") ?? "", "照片");
  const prisma = getPrisma();
  const character = await prisma.character.findFirst({ where: { id: characterId, ownerId }, select: { id: true } });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });
  const photo = await prisma.dailyPhoto.findFirst({ where: { id: photoId, characterId } });
  if (!photo?.relativePath || !photo.mime?.startsWith("image/")) {
    throw createError({ statusCode: 404, statusMessage: "照片文件不存在。" });
  }

  const relative = photo.relativePath.replace(/\\/gu, "/");
  if (!relative.startsWith(`images/${characterId}/`) || path.isAbsolute(relative) || relative.split("/").includes("..")) {
    throw createError({ statusCode: 404, statusMessage: "照片文件不存在。" });
  }
  try {
    const root = await realpath(dataPath("images", characterId));
    const absolute = await realpath(dataPath(relative));
    if (!absolute.startsWith(root + path.sep)) throw new Error("path escaped");
    const buffer = await readFile(absolute);
    setHeader(event, "Content-Type", photo.mime);
    setHeader(event, "Cache-Control", "private, no-store");
    setHeader(event, "X-Content-Type-Options", "nosniff");
    return buffer;
  } catch {
    throw createError({ statusCode: 404, statusMessage: "照片文件不存在。" });
  }
});
