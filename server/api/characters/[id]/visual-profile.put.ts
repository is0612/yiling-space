import { createError } from "h3";
import { requireActorUserId } from "../../../utils/auth";
import { requireUuid } from "../../../utils/local-api";
import { getPrisma } from "../../../utils/prisma";

function readText(value: unknown, field: string, max: number): string {
  if (value === undefined) return "";
  if (typeof value !== "string" || value.length > max) {
    throw createError({ statusCode: 400, statusMessage: `${field}格式不正确或超出长度限制。` });
  }
  return value.trim();
}

export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "");
  const prisma = getPrisma();
  const character = await prisma.character.findFirst({
    where: { id: characterId, ownerId },
    select: { id: true },
  });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });

  const body = await readBody<Record<string, unknown>>(event);
  const coreAppearance = readText(body?.coreAppearance, "核心形象描述", 12000);
  const corePrompt = readText(body?.corePrompt, "核心形象提示词", 12000);
  const negativePrompt = readText(body?.negativePrompt, "负面提示词", 6000);
  const note = readText(body?.note, "版本说明", 300).slice(0, 300);

  return prisma.$transaction(async (tx) => {
    const profile = await tx.characterVisualProfile.upsert({
      where: { characterId },
      create: { characterId, coreAppearance, corePrompt, negativePrompt },
      update: { coreAppearance, corePrompt, negativePrompt },
    });
    const latest = await tx.characterVisualVersion.aggregate({
      where: { profileId: profile.id },
      _max: { revision: true },
    });
    const revision = (latest._max.revision ?? 0) + 1;
    const version = await tx.characterVisualVersion.create({
      data: {
        profileId: profile.id,
        revision,
        status: "DRAFT",
        note,
        snapshot: { coreAppearance, corePrompt, negativePrompt },
      },
    });
    return { profile, draftVersion: version };
  }, { isolationLevel: "Serializable" });
});
