import { createError, defineEventHandler, getRouterParam, readBody } from "h3";
import { requireActorUserId } from "../../../../../utils/auth";
import { requireUuid } from "../../../../../utils/local-api";
import { getPrisma } from "../../../../../utils/prisma";
import { publishGrowthEvent } from "../../../../../utils/growth-event-center";
import { parseDailyLifeActivityInput } from "../../../../../utils/daily-life-input";

export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const prisma = getPrisma();
  const character = await prisma.character.findFirst({ where: { id: characterId, ownerId }, select: { id: true } });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });
  const input = parseDailyLifeActivityInput(await readBody(event));

  try {
    return await prisma.$transaction(async (tx) => {
      let planItem: Awaited<ReturnType<typeof tx.dailyLifePlanItem.findFirst>> = null;
      if (input.planItemId) {
        planItem = await tx.dailyLifePlanItem.findFirst({ where: { id: input.planItemId, characterId, status: "PLANNED" } });
        if (!planItem) throw createError({ statusCode: 404, statusMessage: "这项计划不存在、已变更或不属于当前角色。" });
      }
      const activity = await tx.dailyLifeActivity.create({
        data: {
          characterId, planItemId: planItem?.id ?? null,
          title: input.title || planItem?.title || "",
          detail: input.detail || planItem?.detail || "",
          place: input.place ?? planItem?.place ?? null,
          source: planItem ? "PLAN" : input.source,
          sourceRef: input.sourceRef,
        },
      });
      await publishGrowthEvent(tx, {
        characterId, sourceDomain: "life", eventType: "life.activity.started",
        aggregateType: "DailyLifeActivity", aggregateId: activity.id, occurredAt: activity.startedAt,
        idempotencyKey: "activity-started:" + activity.id,
        payload: { source: activity.source, planItemId: activity.planItemId },
      });
      return { activity };
    });
  } catch (error) {
    if (error && typeof error === "object" && "statusCode" in error) throw error;
    if (error && typeof error === "object" && "code" in error && error.code === "P2002") {
      throw createError({ statusCode: 409, statusMessage: "当前角色已经有一项进行中的活动，请先结束它。" });
    }
    throw error;
  }
});
