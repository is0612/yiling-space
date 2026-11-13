import { createError, defineEventHandler, getQuery, getRouterParam } from "h3";
import { requireActorUserId } from "../../../../utils/auth";
import { requireUuid } from "../../../../utils/local-api";
import { getPrisma } from "../../../../utils/prisma";
import { buildDuplicatePairs, duplicateScope, duplicateSelect } from "../../../../utils/memory-event-duplicates";
export default defineEventHandler(async event => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const dayKey = getQuery(event).dayKey;
  const parsedDay = typeof dayKey === "string" ? new Date(`${dayKey}T12:00:00Z`) : new Date(NaN);
  if (typeof dayKey !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dayKey) || !Number.isFinite(parsedDay.getTime()) || parsedDay.toISOString().slice(0, 10) !== dayKey) throw createError({ statusCode: 400, statusMessage: "请选择有效日期。" });
  const prisma = getPrisma();
  if (!await prisma.character.findFirst({ where: { id: characterId, ownerId }, select: { id: true } })) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });
  const rows = await prisma.memoryEvent.findMany({ where: { dayKey, status: "ACTIVE", memoryScope: { is: duplicateScope(ownerId, characterId) } }, select: duplicateSelect, orderBy: { id: "asc" }, take: 501 });
  if (rows.length > 500) throw createError({ statusCode: 422, statusMessage: "当天可见忆泡超过 500 条，暂不支持重复预览。" });
  return { dayKey, checkedCount: rows.length, limit: 500, ...buildDuplicatePairs(rows) };
});
