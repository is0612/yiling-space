import { createError } from "h3";
import { requireActorUserId } from "../../../../utils/auth";
import { requireUuid } from "../../../../utils/local-api";
import { getPrisma } from "../../../../utils/prisma";

export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "");
  const body = await readBody<{ revision?: number }>(event);
  const revision = Number(body?.revision);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw createError({ statusCode: 400, statusMessage: "版本号无效。" });
  }

  const prisma = getPrisma();
  const character = await prisma.character.findFirst({ where: { id: characterId, ownerId }, select: { id: true } });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });

  return prisma.$transaction(async (tx) => {
    const profile = await tx.characterVisualProfile.findUnique({ where: { characterId } });
    if (!profile) throw createError({ statusCode: 404, statusMessage: "形象档案不存在。" });
    const version = await tx.characterVisualVersion.findFirst({
      where: { profileId: profile.id, revision, status: "DRAFT" },
    });
    if (!version) throw createError({ statusCode: 404, statusMessage: "找不到可发布的草稿版本。" });
    const publishedAt = new Date();
    await tx.characterVisualVersion.updateMany({
      where: { profileId: profile.id, status: "DRAFT", revision: { not: revision } },
      data: { status: "ARCHIVED" },
    });
    const updatedVersion = await tx.characterVisualVersion.update({
      where: { id: version.id },
      data: { status: "PUBLISHED", publishedAt },
    });
    const updatedProfile = await tx.characterVisualProfile.update({
      where: { id: profile.id },
      data: { currentPublishedRevision: revision },
    });
    return { profile: updatedProfile, version: updatedVersion };
  }, { isolationLevel: "Serializable" });
});
