import { createError, getQuery, getRouterParam } from "h3";
import { requireActorUserId } from "../../../utils/auth";
import { requireUuid } from "../../../utils/local-api";
import { getPrisma } from "../../../utils/prisma";

/**
 * 她在群里跟别人聊了什么。
 *
 * 群聊记录本来就是她的记忆（群挂在角色全局记忆范围下），但记忆页只取长期记忆与阶段总结，
 * 原始消息不进这条流，于是「她跟别人的群聊」在页面上看不到。这个接口把群会话单独拉出来：
 * 按群号列会话，再给某个群最近的往来消息。
 *
 * 只认 `g:<群号>` 的会话键 —— 私聊会话挂在各自身份记忆范围下，不从这条路径暴露。
 * 群号来自会话键与 metadata.groupId，标题对老数据不可信（历史标题取的是首条消息前 80 字）。
 */

const MAX_GROUPS = 50;
const MAX_MESSAGES = 120;

function readGroupId(externalConversationId: string | null, metadata: unknown): string | null {
  const matched = /^g:(\d+)$/.exec(externalConversationId ?? "");
  if (matched?.[1]) return matched[1];
  const record = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {};
  const stored = record.groupId;
  return typeof stored === "string" && /^\d+$/.test(stored) ? stored : null;
}

function readStringField(metadata: unknown, key: string): string | null {
  const record = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {};
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 80) : null;
}

export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const prisma = getPrisma();

  const character = await prisma.character.findFirst({
    where: { id: characterId, ownerId },
    select: { id: true },
  });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });

  const query = getQuery(event);
  const requestedId = typeof query.conversationId === "string" && query.conversationId.trim()
    ? requireUuid(query.conversationId, "会话")
    : null;

  const conversations = await prisma.conversation.findMany({
    where: { characterId, externalConversationId: { startsWith: "g:" } },
    orderBy: [{ lastMessageAt: "desc" }, { updatedAt: "desc" }],
    take: MAX_GROUPS,
    select: {
      id: true,
      title: true,
      externalConversationId: true,
      metadata: true,
      lastMessageAt: true,
      updatedAt: true,
      channelBinding: { select: { connection: { select: { displayName: true } } } },
      _count: { select: { messages: true } },
    },
  });

  const groups = conversations.map((conversation) => {
    const groupId = readGroupId(conversation.externalConversationId, conversation.metadata);
    return {
      conversationId: conversation.id,
      groupId,
      // 老会话的标题是首条消息截断出来的，认不出是哪个群；统一按群号展示。
      label: groupId ? `QQ群 ${groupId}` : (conversation.title || "未命名群聊"),
      lastMessageAt: conversation.lastMessageAt,
      updatedAt: conversation.updatedAt,
      messageCount: conversation._count.messages,
      connectionName: conversation.channelBinding?.connection?.displayName ?? null,
    };
  });

  const selected = requestedId
    ? groups.find((group) => group.conversationId === requestedId) ?? null
    : groups[0] ?? null;
  if (requestedId && !selected) {
    throw createError({ statusCode: 404, statusMessage: "群聊不存在或不属于当前角色。" });
  }

  let messages: Array<{
    id: string; role: string; content: string; occurredAt: Date; metadata: unknown;
  }> = [];
  if (selected) {
    const descending = await prisma.message.findMany({
      where: { conversationId: selected.conversationId },
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      take: MAX_MESSAGES,
      select: { id: true, role: true, content: true, occurredAt: true, metadata: true },
    });
    messages = descending.reverse();
  }

  return {
    groups,
    selectedConversationId: selected?.conversationId ?? null,
    messages: messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      occurredAt: message.occurredAt,
      // 发言人昵称可能缺失，退回群内成员代号；两者都没有就交给前端显示「群友」。
      author: readStringField(message.metadata, "authorDisplayName"),
      member: readStringField(message.metadata, "member"),
    })),
    totals: {
      groups: groups.length,
      messages: groups.reduce((sum, group) => sum + group.messageCount, 0),
    },
  };
});
