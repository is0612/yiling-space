import { createError, getQuery, getRouterParam } from "h3";
import { requireActorUserId } from "../../../../utils/auth";
import { requireUuid } from "../../../../utils/local-api";
import { getPrisma } from "../../../../utils/prisma";
import { localDayKey } from "../../../../utils/memory-event-time";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

function positiveInt(value: unknown, fallback: number, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

/** 角色「有忆泡的日子」列表：先按天聚合，再分页，避免多个记忆范围重复占位。 */
export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const prisma = getPrisma();
  const character = await prisma.character.findFirst({
    where: { id: characterId, ownerId },
    select: { id: true, memorySetting: { select: { timezone: true } } },
  });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });

  const timeZone = character.memorySetting?.timezone || "Asia/Shanghai";
  const today = localDayKey(new Date(), timeZone);
  const params = getQuery(event);
  const pageSize = positiveInt(params.pageSize, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const requestedPage = positiveInt(params.page, 1);
  const query = String(params.q ?? "").trim().slice(0, 40);

  if (query) {
    const where = {
      memoryScope: { is: { characterId } },
      status: "ACTIVE" as const,
      OR: [
        { title: { contains: query, mode: "insensitive" as const } },
        { detail: { contains: query, mode: "insensitive" as const } },
        { participants: { has: query } },
      ],
    };
    // 按日期去重后分页，不再用 take: 301 截断更早的搜索命中。
    const grouped = await prisma.memoryEvent.groupBy({
      by: ["dayKey"], where, orderBy: { dayKey: "desc" }, _count: { _all: true },
    });
    const total = grouped.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(requestedPage, totalPages);
    const current = grouped.slice((page - 1) * pageSize, page * pageSize);
    const dayKeys = current.map((row) => row.dayKey);
    const progressWhere = { memoryScope: { is: { characterId } }, dayKey: { in: dayKeys } };
    const [progressRows, draftRows] = await Promise.all([
      prisma.memoryEventDay.groupBy({
        by: ["dayKey"], where: progressWhere, _max: { extractedAt: true },
      }),
      prisma.memoryEventDay.findMany({
        where: { ...progressWhere, state: "DRAFT" }, select: { dayKey: true },
      }),
    ]);
    const progressByDay = new Map(progressRows.map((row) => [row.dayKey, row._max.extractedAt]));
    const draftDays = new Set(draftRows.map((row) => row.dayKey));
    const rows = current.map((row) => ({
      dayKey: row.dayKey,
      state: !progressByDay.has(row.dayKey) ? null : draftDays.has(row.dayKey) ? "DRAFT" as const : "FINAL" as const,
      eventCount: row._count._all,
      extractedAt: progressByDay.get(row.dayKey)?.toISOString() ?? null,
    }));
    return { today, timeZone, days: rows, query, page, pageSize, total, totalPages };
  }

  // 同一天可能有多个记忆范围；按 dayKey 聚合后再分页，并补入尚未出现的今天。
  const groupedRows = await prisma.memoryEventDay.groupBy({
    by: ["dayKey"],
    where: { memoryScope: { is: { characterId } } },
    orderBy: { dayKey: "desc" },
    _sum: { eventCount: true },
    _max: { extractedAt: true },
  });
  const byDay = new Map<string, (typeof groupedRows)[number] | null>();
  for (const row of groupedRows) byDay.set(row.dayKey, row);
  if (!byDay.has(today)) byDay.set(today, null);
  const allDayKeys = [...byDay.keys()].sort((left, right) => right.localeCompare(left));
  const total = allDayKeys.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requestedPage, totalPages);
  const dayKeys = allDayKeys.slice((page - 1) * pageSize, page * pageSize);
  const draftRows = await prisma.memoryEventDay.findMany({
    where: {
      memoryScope: { is: { characterId } },
      state: "DRAFT",
      dayKey: { in: dayKeys },
    },
    select: { dayKey: true },
  });
  const draftDays = new Set(draftRows.map((row) => row.dayKey));
  const rows = dayKeys.map((dayKey) => {
    const day = byDay.get(dayKey);
    return {
      dayKey,
      state: !day ? "DRAFT" as const : draftDays.has(dayKey) ? "DRAFT" as const : "FINAL" as const,
      eventCount: day?._sum.eventCount ?? 0,
      extractedAt: day?._max.extractedAt?.toISOString() ?? null,
    };
  });
  return { today, timeZone, days: rows, query: "", page, pageSize, total, totalPages };
});
