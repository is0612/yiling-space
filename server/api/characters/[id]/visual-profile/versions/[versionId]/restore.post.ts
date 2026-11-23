import { createError } from "h3";
import { requireActorUserId } from "../../../../../../utils/auth";
import { requireUuid, readTrimmedString } from "../../../../../../utils/local-api";
import { getPrisma } from "../../../../../../utils/prisma";

type Snapshot = { coreAppearance?: unknown; corePrompt?: unknown; negativePrompt?: unknown; outfits?: unknown };

export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const versionId = requireUuid(getRouterParam(event, "versionId") ?? "", "版本");
  const prisma = getPrisma();
  const character = await prisma.character.findFirst({ where: { id: characterId, ownerId }, select: { id: true } });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });
  const body = await readBody<{ note?: unknown }>(event);
  const note = readTrimmedString(body?.note, "恢复说明", 300) || "从历史版本恢复为新草稿";

  return prisma.$transaction(async (tx) => {
    const profile = await tx.characterVisualProfile.findUnique({ where: { characterId } });
    if (!profile) throw createError({ statusCode: 404, statusMessage: "形象档案不存在。" });
    const source = await tx.characterVisualVersion.findFirst({ where: { id: versionId, profileId: profile.id } });
    if (!source) throw createError({ statusCode: 404, statusMessage: "历史版本不存在。" });

    const snapshot = source.snapshot as Snapshot;
    const coreAppearance = typeof snapshot.coreAppearance === "string" ? snapshot.coreAppearance : "";
    const corePrompt = typeof snapshot.corePrompt === "string" ? snapshot.corePrompt : "";
    const negativePrompt = typeof snapshot.negativePrompt === "string" ? snapshot.negativePrompt : "";
    const outfits = Array.isArray(snapshot.outfits) ? snapshot.outfits.flatMap((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const item = value as Record<string, unknown>;
      if (typeof item.name !== "string" || typeof item.prompt !== "string") return [];
      return [{ name: item.name.slice(0, 100), prompt: item.prompt.slice(0, 6000), isDefault: item.isDefault === true,
        sortOrder: typeof item.sortOrder === "number" && Number.isSafeInteger(item.sortOrder) ? item.sortOrder : 0 }];
    }) : [];

    const updated = await tx.characterVisualProfile.update({ where: { id: profile.id }, data: { coreAppearance, corePrompt, negativePrompt } });
    await tx.characterVisualOutfit.deleteMany({ where: { profileId: profile.id } });
    if (outfits.length) {
      const firstDefault = outfits.findIndex(item => item.isDefault);
      outfits.forEach((item, index) => { item.isDefault = firstDefault >= 0 && index === firstDefault; });
      await tx.characterVisualOutfit.createMany({ data: outfits.map(item => ({ ...item, profileId: profile.id })) });
    }

    const latest = await tx.characterVisualVersion.aggregate({ where: { profileId: profile.id }, _max: { revision: true } });
    const revision = (latest._max.revision ?? 0) + 1;
    const restoredOutfits = await tx.characterVisualOutfit.findMany({ where: { profileId: profile.id }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] });
    const draft = await tx.characterVisualVersion.create({
      data: { profileId: profile.id, revision, status: "DRAFT", note,
        snapshot: { coreAppearance, corePrompt, negativePrompt, outfits: restoredOutfits.map(item => ({
          name: item.name, prompt: item.prompt, isDefault: item.isDefault, sortOrder: item.sortOrder,
        })) } },
    });
    return { profile: updated, draftVersion: draft, restoredFromRevision: source.revision };
  }, { isolationLevel: "Serializable" });
});
