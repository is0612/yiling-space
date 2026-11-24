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
  const todayParts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const datePart = (type: string) => todayParts.find(part => part.type === type)?.value ?? "";
  const defaultDayKey = `${datePart("year")}-${datePart("month")}-${datePart("day")}`;
  const dayKey = typeof query.date === "string" ? query.date : defaultDayKey;
  const parsedDay = new Date(dayKey + "T00:00:00.000Z");
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(dayKey) || !Number.isFinite(parsedDay.getTime()) || parsedDay.toISOString().slice(0, 10) !== dayKey) {
    throw createError({ statusCode: 400, statusMessage: "日期必须是 YYYY-MM-DD。" });
  }
  const [plan, currentActivity, recentActivities, photos] = await Promise.all([
    prisma.dailyLifePlan.findUnique({ where: { characterId_dayKey: { characterId, dayKey } }, include: { items: { orderBy: [{ plannedStartAt: "asc" }, { sortOrder: "asc" }] } } }),
    prisma.dailyLifeActivity.findFirst({ where: { characterId, status: "IN_PROGRESS" }, orderBy: { startedAt: "desc" }, select: { id: true, title: true, detail: true, place: true, source: true, status: true, startedAt: true, completedAt: true, planItemId: true } }),
    prisma.dailyLifeActivity.findMany({ where: { characterId, startedAt: { gte: new Date(Date.now() - 14 * 86400000) } }, orderBy: { startedAt: "desc" }, take: 30, select: { id: true, title: true, detail: true, place: true, source: true, status: true, startedAt: true, completedAt: true, planItemId: true } }),
    prisma.dailyPhoto.findMany({ where: { characterId, generatedAt: { gte: new Date(Date.now() - 30 * 86400000) } }, orderBy: { generatedAt: "desc" }, take: 30, select: { id: true, activityId: true, trigger: true, status: true, prompt: true, provider: true, model: true, generationMode: true, mime: true, width: true, height: true, caption: true, generatedAt: true, deliveredAt: true } }),
  ]);
  return { dayKey, plan, currentActivity, recentActivities, photos };
});
