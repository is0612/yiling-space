import { createError, defineEventHandler, getRouterParam, readBody } from "h3";
import { requireActorUserId } from "../../../../../../utils/auth";
import { requireUuid } from "../../../../../../utils/local-api";
import { getPrisma } from "../../../../../../utils/prisma";
import { publishGrowthEvent } from "../../../../../../utils/growth-event-center";

export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const photoId = requireUuid(getRouterParam(event, "photoId") ?? "", "照片");
  const prisma = getPrisma();
  const character = await prisma.character.findFirst({ where: { id: characterId, ownerId }, select: { id: true } });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });

  const body = await readBody(event);
  const activityId = body && typeof body === "object" && typeof body.activityId === "string" && body.activityId.trim()
    ? requireUuid(body.activityId.trim(), "活动") : null;
  return prisma.$transaction(async (tx) => {
    const photo = await tx.dailyPhoto.findFirst({ where: { id: photoId, characterId } });
    if (!photo) throw createError({ statusCode: 404, statusMessage: "照片不存在。" });
    if (activityId) {
      const activity = await tx.dailyLifeActivity.findFirst({ where: { id: activityId, characterId } });
      if (!activity) throw createError({ statusCode: 404, statusMessage: "活动不存在或不属于当前角色。" });
    }
    if (photo.activityId === activityId) return { photo, unchanged: true };
    const updated = await tx.dailyPhoto.update({ where: { id: photoId }, data: { activityId } });
    await publishGrowthEvent(tx, {
      characterId, sourceDomain: "life", eventType: "life.photo.associated",
      aggregateType: "DailyPhoto", aggregateId: photoId, occurredAt: new Date(),
      idempotencyKey: "photo-associated:" + photoId + ":" + (activityId ?? "none"),
      payload: { activityId },
    });
    return { photo: updated, unchanged: false };
  });
});
