import { createError, getQuery, getRouterParam } from "h3";
import { requireActorUserId } from "../../../utils/auth";
import { requireUuid } from "../../../utils/local-api";
import { getPrisma } from "../../../utils/prisma";
import { toMemoryTimelineDtos } from "../../../utils/memory-timeline-dto";
import { localDayKey } from "../../../utils/memory-event-time";

/** 允许按需裁剪的种类。记忆页要 memory + snapshot + 忆泡，消息/平台事件不进这条流。 */
const ALL_KINDS = new Set(["message", "memory", "snapshot", "memoryEvent"]);

/**
 * 角色的时间线。
 *
 * 以前固定返回「最新 250 条消息 + 250 条记忆 + 100 份总结」，合并后统一截 300 条。
 * 对本项目「记忆中枢」的定位来说这个配额是反的：聊天一多，消息会把记忆挤出窗口，
 * 记忆页就翻不到记忆了。现在分两层：
 *
 * - `kinds` 决定这条流里放什么（默认全部，保持旧行为）；记忆页传 `kinds=memory,snapshot`，
 *   省下的额度全给记忆（250 → 400）。
 * - `counts` 不管你取没取，都由数据库直接数。统计带因此不会因为「没取消息」而显示成 0。
 */
export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const prisma = getPrisma();

  const character = await prisma.character.findFirst({
    where: { id: characterId, ownerId },
    select: { id: true, memorySetting: { select: { timezone: true } } },
  });

  if (!character) {
    throw createError({ statusCode: 404, statusMessage: "角色不存在。" });
  }

  const query = getQuery(event);
  const requested = String(query.kinds ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => ALL_KINDS.has(item));
  const kinds = requested.length > 0 ? new Set(requested) : ALL_KINDS;
  const includeMessages = kinds.has("message");
  // 上限 500：一次翻太多对页面没意义，也防止有人拿它当导出接口用。
  const limit = Math.min(Math.max(Number(query.limit) || 300, 1), 500);

  const conversationWhere = { conversation: { is: { characterId } } };
  const memoryWhere = { status: { not: "TRASHED" as const }, memoryScope: { is: { characterId } } };
  const snapshotWhere = { memoryScope: { is: { characterId } } };
  const eventWhere = { status: "ACTIVE" as const, memoryScope: { is: { characterId } } };

  const [messages, memoryItems, snapshots, events, messageCount, eventCount, memoryCount, snapshotCount, memoryEventCount] = await Promise.all([
    includeMessages
      ? prisma.message.findMany({
        where: conversationWhere,
        orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
        take: 250,
        select: {
          id: true,
          role: true,
          eventType: true,
          content: true,
          occurredAt: true,
          externalMessageId: true,
          conversation: {
            select: {
              id: true,
              title: true,
              channelBinding: {
                select: { connection: { select: { displayName: true } } },
              },
            },
          },
        },
      })
      : Promise.resolve([]),
    prisma.memoryItem.findMany({
      where: memoryWhere,
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: includeMessages ? 250 : 400,
      select: {
        id: true,
        category: true,
        content: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        memoryScope: { select: { scopeType: true } },
      },
    }),
    prisma.memorySnapshot.findMany({
      where: snapshotWhere,
      orderBy: [{ createdAt: "desc" }, { version: "desc" }],
      take: 100,
      include: { sources: { select: { sourceType: true } } },
    }),
    kinds.has("memoryEvent")
      ? prisma.memoryEvent.findMany({
        where: eventWhere,
        orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
        take: 200,
        select: {
          id: true,
          occurredAt: true,
          timeOfDay: true,
          place: true,
          participants: true,
          title: true,
          detail: true,
          state: true,
          memoryScope: { select: { scopeType: true } },
        },
      })
      : Promise.resolve([]),
    prisma.message.count({ where: conversationWhere }),
    prisma.message.count({ where: { ...conversationWhere, eventType: { not: "message" } } }),
    prisma.memoryItem.count({ where: memoryWhere }),
    prisma.memorySnapshot.count({ where: snapshotWhere }),
    prisma.memoryEvent.count({ where: eventWhere }),
  ]);

  const timeZone = character.memorySetting?.timezone || "Asia/Shanghai";
  const entries = toMemoryTimelineDtos(
    { messages, memoryItems, snapshots, events },
    timeZone,
    limit,
  );

  // 每天的整理进度：页面靠它显示「上次整理 14:20」，并区分「今天还在长」。
  const days = await prisma.memoryEventDay.findMany({
    where: { memoryScope: { is: { characterId } } },
    orderBy: { dayKey: "desc" },
    take: 60,
    select: { dayKey: true, state: true, eventCount: true, extractedAt: true },
  });

  return {
    entries,
    days: days.map((day) => ({
      dayKey: day.dayKey,
      state: day.state,
      eventCount: day.eventCount,
      extractedAt: day.extractedAt?.toISOString() ?? null,
    })),
    // 「今天」按角色时区算，前端不用自己猜时区。
    today: localDayKey(new Date(), timeZone),
    counts: {
      message: messageCount,
      event: eventCount,
      memory: memoryCount,
      snapshot: snapshotCount,
      memoryEvent: memoryEventCount,
    },
  };
});
