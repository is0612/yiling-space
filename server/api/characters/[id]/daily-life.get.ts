import { createError, defineEventHandler, getQuery, getRouterParam } from "h3";
import { requireActorUserId } from "../../../utils/auth";
import { requireUuid } from "../../../utils/local-api";
import { getPrisma } from "../../../utils/prisma";

export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const prisma = getPrisma();
  const character = await prisma.character.findFirst({ where: { id: characterId, ownerId }, select: { id: true } });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });

  const query = getQuery(event);
  const dayKey = typeof query.date === "string" ? query.date : new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(dayKey)) throw createError({ statusCode: 400, statusMessage: "日期必须是 YYYY-MM-DD。" });
  const [plan, currentActivity, recentActivities, photos] = await Promise.all([
    prisma.dailyLifePlan.findUnique({ where: { characterId_dayKey: { characterId, dayKey } }, include: { items: { orderBy: [{ plannedStartAt: "asc" }, { sortOrder: "asc" }] } } }),
    prisma.dailyLifeActivity.findFirst({ where: { characterId, status: "IN_PROGRESS" }, orderBy: { startedAt: "desc" } }),
    prisma.dailyLifeActivity.findMany({ where: { characterId, startedAt: { gte: new Date(Date.now() - 14 * 86400000) } }, orderBy: { startedAt: "desc" }, take: 30 }),
    prisma.dailyPhoto.findMany({ where: { characterId, generatedAt: { gte: new Date(Date.now() - 30 * 86400000) } }, orderBy: { generatedAt: "desc" }, take: 30 }),
  ]);
  return { dayKey, plan, currentActivity, recentActivities, photos };
});
