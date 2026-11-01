import { createError, getRouterParam } from "h3";
import { requireActorUserId } from "../../../../utils/auth";
import { requireUuid } from "../../../../utils/local-api";
import { getPrisma } from "../../../../utils/prisma";
import { resolveDayWindow } from "../../../../utils/memory-event-time";

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

  const events = await prisma.memoryEvent.findMany({
    where: { dayKey, memoryScope: { is: { characterId } } },
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
  });

  const window = resolveDayWindow(dayKey, timeZone);
  const messages = await prisma.message.findMany({
    where: {
      conversation: { is: { characterId } },
      occurredAt: { gte: window.start, lt: window.end },
    },
    orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
    take: 300,
    select: {
      id: true,
      role: true,
      content: true,
      occurredAt: true,
      conversation: { select: { id: true, title: true, externalConversationId: true } },
    },
  });

  /**
   * 原文按会话分组：同一天可能同时在几个群里说话，混成一条流水线后很难对齐
   * ——「这句是群里说的还是私聊说的」全靠猜。群聊标题写「QQ群 <群号>」，私聊是会话标题。
   */
  const groups = new Map<string, { id: string; title: string; messages: Array<{ id: string; role: string; content: string; occurredAt: string }> }>();
  for (const message of messages) {
    const key = message.conversation.id;
    const group = groups.get(key) ?? {
      id: key,
      title: message.conversation.title
        || (message.conversation.externalConversationId?.startsWith("g:")
          ? `QQ群 ${message.conversation.externalConversationId.slice(2)}`
          : "私聊"),
      messages: [],
    };
    group.messages.push({
      id: message.id,
      role: message.role,
      content: message.content.slice(0, 500),
      occurredAt: message.occurredAt.toISOString(),
    });
    groups.set(key, group);
  }

  // 那天整理忆泡花了多少：单独记成 kind=events，和 8 天快照的开销分开。
  const usage = await prisma.modelUsage.aggregate({
    where: { characterId, kind: "events", createdAt: { gte: window.start, lt: window.end } },
    _count: { _all: true },
    _sum: { totalTokens: true },
  });

  return {
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
    messageGroups: [...groups.values()],
    usage: { calls: usage._count._all, tokens: usage._sum.totalTokens ?? 0 },
  };
});
