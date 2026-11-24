import { createError, defineEventHandler, getRouterParam } from "h3";
import { requireActorUserId } from "../../../../../../utils/auth";
import { requireUuid } from "../../../../../../utils/local-api";
import { getPrisma } from "../../../../../../utils/prisma";
import { publishGrowthEvent } from "../../../../../../utils/growth-event-center";

export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const activityId = requireUuid(getRouterParam(event, "activityId") ?? "", "活动");
  const prisma = getPrisma();
  const character = await prisma.character.findFirst({ where: { id: characterId, ownerId }, select: { id: true } });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });

  return prisma.$transaction(async (tx) => {
    const current = await tx.dailyLifeActivity.findFirst({ where: { id: activityId, characterId, status: "IN_PROGRESS" } });
    if (!current) throw createError({ statusCode: 404, statusMessage: "进行中的活动不存在或已经结束。" });
    const completedAt = new Date();
    const updated = await tx.dailyLifeActivity.updateMany({
      where: { id: activityId, characterId, status: "IN_PROGRESS" },
      data: { status: "COMPLETED", completedAt },
    });
    if (updated.count !== 1) throw createError({ statusCode: 409, statusMessage: "活动状态刚刚发生变化，请刷新后重试。" });
    await publishGrowthEvent(tx, {
      characterId, sourceDomain: "life", eventType: "life.activity.completed",
      aggregateType: "DailyLifeActivity", aggregateId: activityId, occurredAt: completedAt,
      idempotencyKey: "activity-completed:" + activityId,
      payload: { source: current.source, planItemId: current.planItemId },
    });
    return { activity: await tx.dailyLifeActivity.findFirstOrThrow({ where: { id: activityId, characterId } }) };
  });
});
