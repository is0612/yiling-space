import { createError, getRouterParam } from "h3";
import { requireActorUserId } from "../../../../utils/auth";
import { requireUuid } from "../../../../utils/local-api";
import { getPrisma } from "../../../../utils/prisma";
import { resolveDayWindow } from "../../../../utils/memory-event-time";
import { readMessageSpeaker } from "../../../../utils/conversation-message";

/**
 * 某一天的忆泡 + 当天原文。
 *
 * 两部分一起给：忆泡是整理过的「那天发生了什么」，原文是「当时到底怎么说的」。
 * 页面上默认看忆泡，需要时再展开原文 —— 两者都受同一套范围隔离约束。
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
  const [events, eventsTotal] = await Promise.all([
    prisma.memoryEvent.findMany({
      where: eventWhere,
      orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
      take: 100,
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
    }),
    prisma.memoryEvent.count({ where: eventWhere }),
  ]);

  const window = resolveDayWindow(dayKey, timeZone);
  /**
   * 原文按会话分组，每组取「当天最近的 N 条」。
   *
   * 以前是全局升序取 300 条：聊得多的那天（单群一天能有两千条）300 条只够覆盖到
   * 凌晨 —— 2026-11-05 实测截在 00:48，晚上的对话一条都看不到，「查看原文」等于白点。
   * 现在每个会话各取最近的，先保证能看到最近发生的事；`total` 带回当天真实条数，
   * 页面据此说明「只显示最近 N 条」。
   */
  const PER_CONVERSATION_TAKE = 200;
  const conversationTotals = await prisma.message.groupBy({
    by: ["conversationId"],
    where: {
      conversation: { is: { characterId } },
      occurredAt: { gte: window.start, lt: window.end },
    },
    _count: { _all: true },
  });

  const groups = new Map<string, {
    id: string;
    title: string;
    total: number;
    firstAt: number;
    messages: Array<{ id: string; role: string; content: string; occurredAt: string; author: string | null; member: string | null }>;
  }>();

  for (const row of conversationTotals) {
    const rows = await prisma.message.findMany({
      where: {
        conversationId: row.conversationId,
        occurredAt: { gte: window.start, lt: window.end },
      },
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      take: PER_CONVERSATION_TAKE,
      select: {
        id: true,
        role: true,
        content: true,
        occurredAt: true,
        metadata: true,
        conversation: { select: { id: true, title: true, externalConversationId: true } },
      },
    });
    const newest = rows[0];
    if (!newest) continue;
    const group = {
      id: row.conversationId,
      title: newest.conversation.title
        || (newest.conversation.externalConversationId?.startsWith("g:")
          ? `QQ群 ${newest.conversation.externalConversationId.slice(2)}`
          : "私聊"),
      total: row._count._all,
      firstAt: rows[rows.length - 1]!.occurredAt.getTime(),
      /**
       * 发言人：群聊里一条 USER 可能就是不同的人，只标「对方」等于把一屋子人揉成一个人。
       * `member` 是群内稳定代号，昵称缺失时至少还能区分「不是同一个人」。
       */
      messages: [...rows].reverse().map((message) => {
        const speaker = readMessageSpeaker(message.metadata);
        return {
          id: message.id,
          role: message.role,
          content: message.content.slice(0, 500),
          occurredAt: message.occurredAt.toISOString(),
          author: speaker.speaker ?? null,
          member: speaker.member ?? null,
        };
      }),
    };
    groups.set(row.conversationId, group);
  }

  // 那天整理忆泡花了多少：单独记成 kind=events，和 8 天快照的开销分开。
  const usage = await prisma.modelUsage.aggregate({
    where: { characterId, kind: "events", createdAt: { gte: window.start, lt: window.end } },
    _count: { _all: true },
    _sum: { totalTokens: true },
  });

  return {
    timeZone,
    eventsTotal,
    eventsTruncated: eventsTotal > events.length,
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
      scope: entry.memoryScope.scopeType === "USER_PRIVATE" ? "private" : "character",
    })),
    // 会话按「当天第一次开口」排序，读起来和一天的时间走向一致。
    messageGroups: [...groups.values()]
      .sort((left, right) => left.firstAt - right.firstAt)
      .map(({ firstAt: _firstAt, ...group }) => group),
    usage: { calls: usage._count._all, tokens: usage._sum.totalTokens ?? 0 },
  };
});
