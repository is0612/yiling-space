import { createError } from "h3";
import { requireActorUserId } from "../../../utils/auth";
import { requireUuid } from "../../../utils/local-api";
import { getPrisma } from "../../../utils/prisma";
import { snapshotAssetSelect, toSnapshotAssets } from "../../../utils/visual-profile-snapshot";

function readText(value: unknown, field: string, max: number): string {
  if (value === undefined) return "";
  if (typeof value !== "string" || value.length > max) {
    throw createError({ statusCode: 400, statusMessage: `${field}格式不正确或超出长度限制。` });
  }
  return value.trim();
}

/**
 * LoRA 文件名只收末段。
 *
 * 引擎认的是 `models/loras` 下的文件名，传绝对路径或 `../x` 进去只会得到一个
 * "value not in list" 的报错；与其让人对着那句英文猜，不如在这里就收成文件名。
 */
function readLoraName(value: unknown): string {
  const raw = readText(value, "LoRA 文件名", 200);
  return raw.split(/[/\\]/u).pop() ?? "";
}

function readLoraStrength(value: unknown): number {
  if (value === undefined || value === null || value === "") return 1;
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > 2) {
    throw createError({ statusCode: 400, statusMessage: "LoRA 强度要在 0 到 2 之间。" });
  }
  return Math.round(numeric * 100) / 100;
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
  /**
   * LoRA 三项。`undefined` 表示这次请求没提到它们 —— 保持库里原值，
   * 免得只改外貌描述的一次保存把 LoRA 顺手清空（页面是整表单提交，但接口不该假设）。
   */
  const loraName = body?.loraName === undefined ? undefined : readLoraName(body.loraName);
  const loraStrength = body?.loraStrength === undefined ? undefined : readLoraStrength(body.loraStrength);
  const loraTrigger = body?.loraTrigger === undefined ? undefined : readText(body.loraTrigger, "LoRA 触发词", 200);

  return prisma.$transaction(async (tx) => {
    const profile = await tx.characterVisualProfile.upsert({
      where: { characterId },
      create: { characterId, coreAppearance, corePrompt, negativePrompt, loraName: loraName ?? "", loraStrength: loraStrength ?? 1, loraTrigger: loraTrigger ?? "" },
      update: {
        coreAppearance,
        corePrompt,
        negativePrompt,
        ...(loraName === undefined ? {} : { loraName }),
        ...(loraStrength === undefined ? {} : { loraStrength }),
        ...(loraTrigger === undefined ? {} : { loraTrigger }),
      },
    });
    const outfits = await tx.characterVisualOutfit.findMany({ where: { profileId: profile.id }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] });
    const assets = await tx.characterVisualAsset.findMany({ where: { profileId: profile.id }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }], select: snapshotAssetSelect });
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
        snapshot: {
          coreAppearance, corePrompt, negativePrompt,
          // LoRA 进快照：发布哪一版，就固定用哪一版的 LoRA 与强度。
          loraName: profile.loraName, loraStrength: profile.loraStrength, loraTrigger: profile.loraTrigger,
          outfits: outfits.map(item => ({ name: item.name, prompt: item.prompt, isDefault: item.isDefault, sortOrder: item.sortOrder })),
          assets: toSnapshotAssets(assets),
        },
      },
    });
    return { profile, draftVersion: version };
  }, { isolationLevel: "Serializable" });
});
