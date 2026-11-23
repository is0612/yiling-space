import { createError } from "h3";
import { requireActorUserId } from "../../../../../utils/auth";
import { readTrimmedString, requireUuid } from "../../../../../utils/local-api";
import { getPrisma } from "../../../../../utils/prisma";
import { snapshotAssetSelect, toSnapshotAssets } from "../../../../../utils/visual-profile-snapshot";

export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const prisma = getPrisma();
  const character = await prisma.character.findFirst({ where: { id: characterId, ownerId }, select: { id: true } });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });
  const body = await readBody<Record<string, unknown>>(event);
  const name = readTrimmedString(body?.name, "造型名称", 100, { required: true });
  const prompt = readTrimmedString(body?.prompt, "造型提示词", 6000, { required: true });
  const isDefault = body?.isDefault === true;

  return prisma.$transaction(async (tx) => {
    const profile = await tx.characterVisualProfile.upsert({ where: { characterId }, create: { characterId }, update: {} });
    if (isDefault) await tx.characterVisualOutfit.updateMany({ where: { profileId: profile.id }, data: { isDefault: false } });
    const outfit = await tx.characterVisualOutfit.create({ data: { profileId: profile.id, name, prompt, isDefault } });
    const outfits = await tx.characterVisualOutfit.findMany({ where: { profileId: profile.id }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] });
    const assets = await tx.characterVisualAsset.findMany({ where: { profileId: profile.id }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }], select: snapshotAssetSelect });
    const latest = await tx.characterVisualVersion.aggregate({ where: { profileId: profile.id }, _max: { revision: true } });
    const revision = (latest._max.revision ?? 0) + 1;
    await tx.characterVisualVersion.create({ data: { profileId: profile.id, revision, status: "DRAFT", note: "更新服装造型", snapshot: {
      coreAppearance: profile.coreAppearance, corePrompt: profile.corePrompt, negativePrompt: profile.negativePrompt,
      outfits: outfits.map(item => ({ name: item.name, prompt: item.prompt, isDefault: item.isDefault, sortOrder: item.sortOrder })),
      assets: toSnapshotAssets(assets),
    } } });
    return { outfit, draftRevision: revision };
  }, { isolationLevel: "Serializable" });
});
