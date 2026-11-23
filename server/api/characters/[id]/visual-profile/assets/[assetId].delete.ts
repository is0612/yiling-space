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

  // 当前正式版本引用的文件不能直接删除，否则版本快照会指向失效素材。
  // 先发布一个不再引用该素材的新版本，再回来删除。
  await prisma.$transaction(async (tx) => {
    const profile = await tx.characterVisualProfile.findUnique({
      where: { characterId },
      select: { id: true, currentPublishedRevision: true },
    });
    if (profile && profile.currentPublishedRevision > 0) {
      const published = await tx.characterVisualVersion.findFirst({
        where: { profileId: profile.id, revision: profile.currentPublishedRevision, status: "PUBLISHED" },
        select: { snapshot: true },
      });
      const snapshot = published?.snapshot && typeof published.snapshot === "object" && !Array.isArray(published.snapshot)
        ? published.snapshot as Record<string, unknown> : null;
      const assets = Array.isArray(snapshot?.assets) ? snapshot.assets : [];
      const isReferenced = assets.some((item) => item && typeof item === "object"
        && !Array.isArray(item) && (item as Record<string, unknown>).id === assetId);
      if (isReferenced) {
        throw createError({
          statusCode: 409,
          statusMessage: "这张图片仍被当前正式形象版本引用。请先保存并发布一个不再引用它的新版本，再删除素材。",
        });
      }
    }
    await tx.characterVisualAsset.delete({ where: { id: asset.id } });
  }, { isolationLevel: "Serializable" });

  const relative = asset.relativePath.replace(/\\\\/gu, "/");
  if (!relative.startsWith("visual-profile/" + characterId + "/") || path.isAbsolute(relative) || relative.split("/").includes("..")) {
    return { deleted: true, assetId, fileRemoved: false };
  }
  try {
    const root = await realpath(dataPath("visual-profile", characterId));
    const absolute = await realpath(dataPath(relative));
    if (!absolute.startsWith(root + path.sep)) throw new Error("path escaped");
    await unlink(absolute);
    return { deleted: true, assetId, fileRemoved: true };
  } catch {
    return { deleted: true, assetId, fileRemoved: false };
  }
});
