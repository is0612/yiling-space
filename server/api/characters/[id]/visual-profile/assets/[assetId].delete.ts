import { realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { createError } from "h3";
import { requireActorUserId } from "../../../../../utils/auth";
import { requireUuid } from "../../../../../utils/local-api";
import { dataPath } from "../../../../../utils/data-dir";
import { getPrisma } from "../../../../../utils/prisma";

export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const assetId = requireUuid(getRouterParam(event, "assetId") ?? "", "素材");
  const prisma = getPrisma();
  const character = await prisma.character.findFirst({ where: { id: characterId, ownerId }, select: { id: true } });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });
  const asset = await prisma.characterVisualAsset.findUnique({ where: { id: assetId }, include: { profile: { select: { id: true, characterId: true } } } });
  if (!asset || asset.profile.characterId !== characterId) throw createError({ statusCode: 404, statusMessage: "参考图片不存在。" });

  const relative = asset.relativePath.replace(/\\/gu, "/");
  if (!relative.startsWith(`images/${characterId}/`) || path.isAbsolute(relative) || relative.split("/").includes("..")) {
    throw createError({ statusCode: 404, statusMessage: "参考图片不存在。" });
  }
  try {
    const root = await realpath(dataPath("images", characterId));
    const absolute = await realpath(dataPath(relative));
    if (!absolute.startsWith(root + path.sep)) throw new Error("path escaped");
    await unlink(absolute);
  } catch {
    // A missing file does not prevent removal of its stale database reference.
  }
  await prisma.characterVisualAsset.delete({ where: { id: asset.id } });
  return { deleted: true, assetId };
});
