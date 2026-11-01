import { createError, getQuery, getRouterParam } from "h3";
import { requireActorUserId } from "../../../utils/auth";
import { requireUuid } from "../../../utils/local-api";
import { getPrisma } from "../../../utils/prisma";

/**
 * 她跟每个人私聊了什么。
 *
 * 群聊有 `group-chats`，私聊一直没有入口：会话按 `c:<QQ号>` 存在 `conversations` + `messages`，
 * 但记忆页时间线只取记忆与总结，原文不进这条流。私聊量小、产品上要尽量全留，所以单独
 * 按 QQ 号列出来 —— 忆泡从这份记录里整理「那天发生了什么」。
 *
 * 只认 `c:<QQ号>` 的会话键；桌面本地对话走 `/chat`，混进来会重复。
 * 私聊列表最多 50 个（按最后发言排序；实际很少会有人私聊她）。
 * 消息按游标分页：默认最近 200 条，`before` 传上一页最早的时间继续往前翻，
 * 不做「只显示最近 N 条」的硬截断 —— 私聊记录的意义就是能翻到底。
 */

const MAX_CHATS = 50;
const MESSAGE_PAGE_SIZE = 200;

function readChatQq(externalConversationId: string | null): string | null {
  const matched = /^c:(\d+)$/.exec(externalConversationId ?? "");
  return matched?.[1] ?? null;
}

function readStringField(metadata: unknown, key: string): string | null {
  const record = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {};
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 80) : null;
}

function readBooleanField(metadata: unknown, key: string): boolean {
  const record = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {};
  return record[key] === true;
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
  const beforeRaw = typeof query.before === "string" ? query.before.trim() : "";
  const before = beforeRaw ? new Date(beforeRaw) : null;
  if (before && Number.isNaN(before.getTime())) {
    throw createError({ statusCode: 400, statusMessage: "before 必须是时间。" });
  }

  const conversations = await prisma.conversation.findMany({
    where: { characterId, externalConversationId: { startsWith: "c:" } },
    orderBy: [{ lastMessageAt: "desc" }, { updatedAt: "desc" }],
    take: MAX_CHATS,
    select: {
      id: true,
      title: true,
      externalConversationId: true,
      lastMessageAt: true,
      updatedAt: true,
      channelBinding: { select: { connection: { select: { displayName: true } } } },
      _count: { select: { messages: true } },
    },
  });

  const chats = conversations.map((conversation) => {
    const qq = readChatQq(conversation.externalConversationId);
    return {
      conversationId: conversation.id,
      qq,
      // 老会话的标题是首条消息截断出来的，认不出是谁；统一按 QQ 号展示。
      label: qq ? `QQ私聊 ${qq}` : (conversation.title || "未命名私聊"),
      lastMessageAt: conversation.lastMessageAt,
      updatedAt: conversation.updatedAt,
      messageCount: conversation._count.messages,
      connectionName: conversation.channelBinding?.connection?.displayName ?? null,
    };
  });

  const selected = requestedId
    ? chats.find((chat) => chat.conversationId === requestedId) ?? null
    : chats[0] ?? null;
  if (requestedId && !selected) {
    throw createError({ statusCode: 404, statusMessage: "私聊不存在或不属于当前角色。" });
  }

  let rows: Array<{ id: string; role: string; content: string; occurredAt: Date; metadata: unknown }> = [];
  if (selected) {
    rows = await prisma.message.findMany({
      where: {
        conversationId: selected.conversationId,
        ...(before ? { occurredAt: { lt: before } } : {}),
      },
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      take: MESSAGE_PAGE_SIZE,
      select: { id: true, role: true, content: true, occurredAt: true, metadata: true },
    });
    rows.reverse();
  }

  return {
    chats,
    selectedConversationId: selected?.conversationId ?? null,
    messages: rows.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      occurredAt: message.occurredAt,
      author: readStringField(message.metadata, "authorDisplayName"),
      isOwner: readBooleanField(message.metadata, "isOwner"),
    })),
    hasMore: rows.length === MESSAGE_PAGE_SIZE,
    totals: {
      chats: chats.length,
      messages: chats.reduce((sum, chat) => sum + chat.messageCount, 0),
    },
  };
});
