import { createError } from "h3";
import { requireActorUserId } from "../../../../../utils/auth";
import { requireUuid } from "../../../../../utils/local-api";
import { getPrisma } from "../../../../../utils/prisma";

export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const outfitId = requireUuid(getRouterParam(event, "outfitId") ?? "", "造型");
  const prisma = getPrisma();
  const character = await prisma.character.findFirst({ where: { id: characterId, ownerId }, select: { id: true } });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });
  return prisma.$transaction(async (tx) => {
    const profile = await tx.characterVisualProfile.findUnique({ where: { characterId }, select: { id: true, coreAppearance: true, corePrompt: true, negativePrompt: true } });
    if (!profile) throw createError({ statusCode: 404, statusMessage: "形象档案不存在。" });
    const existing = await tx.characterVisualOutfit.findFirst({ where: { id: outfitId, profileId: profile.id }, select: { id: true } });
    if (!existing) throw createError({ statusCode: 404, statusMessage: "造型不存在。" });
    await tx.characterVisualOutfit.delete({ where: { id: outfitId } });
    const outfits = await tx.characterVisualOutfit.findMany({ where: { profileId: profile.id }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] });
    const latest = await tx.characterVisualVersion.aggregate({ where: { profileId: profile.id }, _max: { revision: true } });
    const revision = (latest._max.revision ?? 0) + 1;
    await tx.characterVisualVersion.create({ data: { profileId: profile.id, revision, status: "DRAFT", note: "删除服装造型", snapshot: {
      coreAppearance: profile.coreAppearance, corePrompt: profile.corePrompt, negativePrompt: profile.negativePrompt,
      outfits: outfits.map(item => ({ name: item.name, prompt: item.prompt, isDefault: item.isDefault, sortOrder: item.sortOrder })),
    } } });
    return { deleted: true, draftRevision: revision };
  }, { isolationLevel: "Serializable" });
});
