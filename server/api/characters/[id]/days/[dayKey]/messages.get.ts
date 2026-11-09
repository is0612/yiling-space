import { createError, getRouterParam } from "h3";
import { requireActorUserId } from "../../../../../utils/auth";
import { requireUuid } from "../../../../../utils/local-api";
import { getPrisma } from "../../../../../utils/prisma";
import { resolveDayWindow } from "../../../../../utils/memory-event-time";
import { readMessageSpeaker } from "../../../../../utils/conversation-message";

/**
 * 某一天的对话原文，按会话分组返回。
 *
 * 以前它跟忆泡一起塞在 `GET /days/{dayKey}` 里：一天聊得多的时候（单群一天两千条）
 * 点开日期就要传几百条原文，可页面上默认只看忆泡，原文还得再点一次才展开。
 * 现在点「查看当天原文」才请求这里。不分页：原文本来就是「当天全部」的语义，
 * 每个会话各取最近 200 条，`total` 给出当天真实条数供页面说明。
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
  const window = resolveDayWindow(dayKey, timeZone);

  /**
   * 原文按会话分组，每组取「当天最近的 N 条」。
   *
   * 以前是全局升序取 300 条：聊得多的那天 300 条只够覆盖到凌晨，
   * 晚上的对话一条都看不到，「查看原文」等于白点。现在每个会话各取最近的，
   * 先保证能看到最近发生的事；`total` 带回当天真实条数，页面据此说明「只显示最近 N 条」。
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

  const messageGroups = [...groups.values()]
    // 会话按「当天第一次开口」排序，读起来和一天的时间走向一致。
    .sort((left, right) => left.firstAt - right.firstAt)
    .map(({ firstAt: _firstAt, ...group }) => group);

  return {
    dayKey,
    timeZone,
    messageGroups,
    totalMessages: messageGroups.reduce((sum, group) => sum + group.total, 0),
  };
});
