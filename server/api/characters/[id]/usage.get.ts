import { createError, getRouterParam } from "h3";
import { requireActorUserId } from "../../../utils/auth";
import { requireUuid } from "../../../utils/local-api";
import { getPrisma } from "../../../utils/prisma";
import { readDailyQuota, readDailyUsage, usageDayKey } from "../../../utils/model-usage";

/** 今日模型用量与额度。只读，用于角色模型设置页的看板。 */
export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");

  const prisma = getPrisma();
  const character = await prisma.character.findFirst({
    where: { id: characterId, ownerId },
    select: { id: true, modelConfig: true },
  });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });

  const day = usageDayKey();
  const [usage, quota] = await Promise.all([
    readDailyUsage(characterId, day),
    readDailyQuota(characterId, character.modelConfig, day),
  ]);

  return { day, usage, quota };
});
