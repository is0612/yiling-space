import { createError, getQuery, getRouterParam } from "h3";
import { requireActorUserId } from "../../../../utils/auth";
import { requireUuid } from "../../../../utils/local-api";
import { getPrisma } from "../../../../utils/prisma";
import { resolveDayWindow } from "../../../../utils/memory-event-time";

/**
 * 某一天的忆泡（分页）。
 *
 * 只给「那天发生了什么」：忆泡、进度、当天整理开销。
 * 原文是「当时到底怎么说的」，在 `.../days/{dayKey}/messages`，页面上展开才请求 ——
 * 两者都受同一套范围隔离约束。
 */
export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const dayKey = String(getRouterParam(event, "dayKey") ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) {
    throw createError({ statusCode: 400, statusMessage: "日期格式应为 YYYY-MM-DD。" });
  }

  const prisma = getPrisma();
  const character = await prisma.character.findFirst({
    where: { id: characterId, ownerId },
    select: { id: true, memorySetting: { select: { timezone: true } } },
  });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });

  const timeZone = character.memorySetting?.timezone || "Asia/Shanghai";
  /**
   * 这一天的进度行可能不止一条：主线一个范围、每段私聊各自一个范围。
   * 下面的忆泡本来就是跨范围一起取的，进度行也必须合并成一条，否则
   * 「上次整理」会随机显示到私聊那份较早的时间上。
   */
  const dayRows = await prisma.memoryEventDay.findMany({
    where: { dayKey, memoryScope: { is: { characterId } } },
    select: { dayKey: true, state: true, eventCount: true, extractedAt: true },
  });
  const day = dayRows.length
    ? {
      dayKey,
      state: (dayRows.some((row) => row.state === "DRAFT") ? "DRAFT" : "FINAL") as "DRAFT" | "FINAL",
      eventCount: dayRows.reduce((sum, row) => sum + row.eventCount, 0),
      extractedAt: dayRows.reduce<Date | null>(
        (latest, row) => (row.extractedAt && (!latest || row.extractedAt > latest) ? row.extractedAt : latest),
        null,
      ),
    }
    : null;

  const eventWhere = { dayKey, memoryScope: { is: { characterId } } };
  const eventsTotal = await prisma.memoryEvent.count({ where: eventWhere });
  const params = getQuery(event);
  const pageSize = 20;
  const requestedPage = Number(params.page);
  const totalPages = Math.max(1, Math.ceil(eventsTotal / pageSize));
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0
    ? Math.min(requestedPage, totalPages)
    : 1;
  const events = await prisma.memoryEvent.findMany({
      where: eventWhere,
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        occurredAt: true,
        timeOfDay: true,
        place: true,
        participants: true,
        title: true,
        detail: true,
        state: true,
        status: true,
        confidence: true,
        sourceMessageIds: true,
        memoryScope: { select: { scopeType: true } },
      },
    });

  const window = resolveDayWindow(dayKey, timeZone);

  // 当天原文是另一个接口（`.../days/{dayKey}/messages`）：页面上默认只看忆泡，
  // 展开「查看当天原文」才去取。这里只返回忆泡、进度和当天整理开销。
  const usage = await prisma.modelUsage.aggregate({
    where: { characterId, kind: "events", createdAt: { gte: window.start, lt: window.end } },
    _count: { _all: true },
    _sum: { totalTokens: true },
  });

  return {
    timeZone,
    eventsTotal,
    eventsPage: page,
    eventsPageSize: pageSize,
    eventsTotalPages: totalPages,
    day: day
      ? { ...day, extractedAt: day.extractedAt?.toISOString() ?? null }
      : { dayKey, state: null, eventCount: 0, extractedAt: null },
    events: events.map((entry) => ({
      id: entry.id,
      occurredAt: entry.occurredAt.toISOString(),
      timeOfDay: entry.timeOfDay,
      place: entry.place,
      participants: entry.participants,
      title: entry.title,
      detail: entry.detail,
      state: entry.state,
      status: entry.status,
      confidence: entry.confidence,
      sourceMessageIds: entry.sourceMessageIds,
      scope: entry.memoryScope.scopeType === "USER_PRIVATE"
        ? "private"
        : entry.memoryScope.scopeType === "EXTERNAL_IDENTITY" ? "external" : "character",
    })),
    usage: { calls: usage._count._all, tokens: usage._sum.totalTokens ?? 0 },
  };
});
