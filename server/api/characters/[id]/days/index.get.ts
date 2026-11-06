import { createError, getQuery, getRouterParam } from "h3";
import { requireActorUserId } from "../../../../utils/auth";
import { requireUuid } from "../../../../utils/local-api";
import { getPrisma } from "../../../../utils/prisma";
import { localDayKey } from "../../../../utils/memory-event-time";

/**
 * 角色「有忆泡的日子」列表。
 *
 * 数据源是 `memory_event_days`（一天一行，带整理进度），不是从忆泡反推的 ——
 * 这样「今天还没整理」的日子也能出现在列表里，而不是凭空消失。
 */
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

  /**
   * 搜索：按忆泡标题/详情匹配，返回命中的日期。
   *
   * 日期列表最多 90 天，翻三个月前的「那次吵架」很费劲；这里先把「命中词的日期」
   * 挑出来，用户再点进去看当天全部内容。搜的是忆泡而不是原文 —— 原文有保留期，
   * 忆泡才是长期可查的那一层。
   */
  const query = String(getQuery(event).q ?? "").trim().slice(0, 40);
  if (query) {
    const matched = await prisma.memoryEvent.findMany({
      where: {
        memoryScope: { is: { characterId } },
        status: "ACTIVE",
        OR: [
          { title: { contains: query, mode: "insensitive" } },
          { detail: { contains: query, mode: "insensitive" } },
          { participants: { has: query } },
        ],
      },
      orderBy: [{ occurredAt: "desc" }],
      take: 301,
      select: { dayKey: true },
    });
    const truncated = matched.length > 300;
    const counts = new Map<string, number>();
    for (const item of matched.slice(0, 300)) counts.set(item.dayKey, (counts.get(item.dayKey) ?? 0) + 1);
    const dayKeys = [...counts.keys()].sort((left, right) => right.localeCompare(left));
    const progressWhere = {
      memoryScope: { is: { characterId } },
      dayKey: { in: dayKeys },
    };
    const [progressRows, draftRows] = await Promise.all([
      prisma.memoryEventDay.groupBy({
        by: ["dayKey"],
        where: progressWhere,
        _max: { extractedAt: true },
      }),
      prisma.memoryEventDay.findMany({
        where: { ...progressWhere, state: "DRAFT" },
        select: { dayKey: true },
      }),
    ]);
    const progressByDay = new Map(progressRows.map((row) => [row.dayKey, row._max.extractedAt]));
    const draftDays = new Set(draftRows.map((row) => row.dayKey));
    const rows = dayKeys.map((dayKey) => ({
      dayKey,
      // 搜索结果也展示真实进度；没有进度行时保持 null，不把已完成日期误标成「还在记」。
      state: !progressByDay.has(dayKey) ? null : draftDays.has(dayKey) ? "DRAFT" as const : "FINAL" as const,
      // 这里的条数是「命中的条数」，不是当天全部条数。
      eventCount: counts.get(dayKey) ?? 0,
      extractedAt: progressByDay.get(dayKey)?.toISOString() ?? null,
    }));
    return { today, timeZone, days: rows, query, truncated };
  }

  /**
   * 同一天在多个记忆范围各有一行进度：角色主线（CHARACTER_GLOBAL）一份，
   * 和某人的私聊（EXTERNAL_IDENTITY / USER_PRIVATE）又一份。
   *
   * 日历是「一天一行」，直接把原始行列出来，昨天就会出现两次
   * （2026-10-31 实测：主线 25 条 + QQ 私聊 1 条 → 两个「昨天」）。这里按 dayKey 合并：
   * 条数求和，整理时间取最晚，任一范围还没收口就仍算 DRAFT。
   *
   * 用 groupBy 而不是取回所有行在内存里合并：`take: 90` 必须落在**天**上，
   * 否则多范围的行会把 90 格额度吃掉，实际只看得到一半天数。
   */
  const groupedRows = await prisma.memoryEventDay.groupBy({
    by: ["dayKey"],
    where: { memoryScope: { is: { characterId } } },
    orderBy: { dayKey: "desc" },
    take: 91,
    _sum: { eventCount: true },
    _max: { extractedAt: true },
  });
  let truncated = groupedRows.length > 90;
  const grouped = groupedRows.slice(0, 90);

  // state 没法在 groupBy 里聚合，单独取「还有范围停在 DRAFT」的天。
  const draftRows = grouped.length
    ? await prisma.memoryEventDay.findMany({
      where: {
        memoryScope: { is: { characterId } },
        state: "DRAFT",
        dayKey: { in: grouped.map((item) => item.dayKey) },
      },
      select: { dayKey: true },
    })
    : [];
  const draftDays = new Set(draftRows.map((item) => item.dayKey));

  const rows = grouped.map((day) => ({
    dayKey: day.dayKey,
    state: (draftDays.has(day.dayKey) ? "DRAFT" : "FINAL") as "DRAFT" | "FINAL",
    eventCount: day._sum.eventCount ?? 0,
    extractedAt: day._max.extractedAt?.toISOString() ?? null,
  }));
  // 今天还没整理过时也补一行：否则「今天」会从列表里整个消失，用户以为页面坏了。
  if (!rows.some((row) => row.dayKey === today)) {
    rows.unshift({ dayKey: today, state: "DRAFT", eventCount: 0, extractedAt: null });
    if (rows.length > 90) {
      rows.pop();
      truncated = true;
    }
  }

  return { today, timeZone, days: rows, query: "", truncated };
});
