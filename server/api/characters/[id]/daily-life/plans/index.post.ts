import { createError, defineEventHandler, getRouterParam, readBody } from "h3";
import { requireActorUserId } from "../../../../utils/auth";
import { requireUuid } from "../../../../utils/local-api";
import { getPrisma } from "../../../../utils/prisma";
import { publishGrowthEvent } from "../../../../utils/growth-event-center";
import { parseDailyLifePlanInput } from "../../../../utils/daily-life-input";

export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const prisma = getPrisma();
  const character = await prisma.character.findFirst({ where: { id: characterId, ownerId }, select: { id: true } });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });
  const input = parseDailyLifePlanInput(await readBody(event));

  try {
    return await prisma.$transaction(async (tx) => {
      const existing = await tx.dailyLifePlan.findUnique({ where: { characterId_dayKey: { characterId, dayKey: input.dayKey } } });
      if (existing) throw createError({ statusCode: 409, statusMessage: "这一天已经有生活计划，请使用调整接口，不要覆盖已有安排。" });
      const plan = await tx.dailyLifePlan.create({
        data: {
          characterId, dayKey: input.dayKey, timeZone: input.timeZone, lifeType: input.lifeType,
          summary: input.summary, generatedAt: new Date(),
          items: { create: input.items.map(item => ({ ...item, characterId })) },
        },
        include: { items: { orderBy: [{ plannedStartAt: "asc" }, { sortOrder: "asc" }] } },
      });
      await publishGrowthEvent(tx, {
        characterId, sourceDomain: "life", eventType: "life.plan.created",
        aggregateType: "DailyLifePlan", aggregateId: plan.id, occurredAt: plan.createdAt,
        idempotencyKey: "plan-created:" + plan.id,
        payload: { dayKey: plan.dayKey, lifeType: plan.lifeType, itemCount: plan.items.length },
      });
      return { plan };
    });
  } catch (error) {
    if (error && typeof error === "object" && "statusCode" in error) throw error;
    if (error && typeof error === "object" && "code" in error && error.code === "P2002") {
      throw createError({ statusCode: 409, statusMessage: "这一天的计划刚刚被创建，请刷新后查看。" });
    }
    throw error;
  }
});
