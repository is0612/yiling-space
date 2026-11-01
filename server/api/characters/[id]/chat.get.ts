import { createError, getQuery, getRouterParam } from "h3";
import { readStoredChatSources } from "../../../utils/chat-sources";
import { resolveChatModelSettings } from "../../../utils/chat-model-config";
import { requireActorUserId } from "../../../utils/auth";
import { requireUuid } from "../../../utils/local-api";
import { getPrisma } from "../../../utils/prisma";

export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const query = getQuery(event);
  const requestedConversationId = query.conversationId;
  if (requestedConversationId !== undefined && typeof requestedConversationId !== "string") {
    throw createError({ statusCode: 400, statusMessage: "conversationId 参数无效。" });
  }
  const conversationId = typeof requestedConversationId === "string" && requestedConversationId
    ? requireUuid(requestedConversationId, "会话")
    : null;

  const requestedStatus = query.status;
  if (requestedStatus !== undefined && requestedStatus !== "ACTIVE" && requestedStatus !== "ARCHIVED") {
    throw createError({ statusCode: 400, statusMessage: "status 只支持 ACTIVE 或 ARCHIVED。" });
  }
  const conversationStatus: "ACTIVE" | "ARCHIVED" = requestedStatus === "ARCHIVED" ? "ARCHIVED" : "ACTIVE";
  const rawSearchTerm = query.q;
  if (rawSearchTerm !== undefined && typeof rawSearchTerm !== "string") {
    throw createError({ statusCode: 400, statusMessage: "q 参数无效。" });
  }
  const searchTerm = typeof rawSearchTerm === "string" ? rawSearchTerm.trim() : "";
  if (searchTerm.length > 120) {
    throw createError({ statusCode: 400, statusMessage: "会话搜索词不能超过 120 个字符。" });
  }

  const prisma = getPrisma();

  const character = await prisma.character.findFirst({
    where: { id: characterId, ownerId },
    select: { id: true, name: true, modelConfig: true, memoryScopes: { where: { scopeType: "CHARACTER_GLOBAL" }, select: { id: true }, take: 1 } },
  });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });
  const memoryScopeId = character.memoryScopes[0]?.id;
  if (!memoryScopeId) throw createError({ statusCode: 409, statusMessage: "该角色尚未建立全局记忆范围，请重新保存角色档案。" });

  // 桌面端 AI 对话只认 channelBindingId 为空的会话：带绑定的是 QQ 等外部渠道的记录，
  // 它们可能和本角色共用同一个 CHARACTER_GLOBAL scope，不过滤就会混进这里的会话列表。
  const conversationWhere = {
    characterId,
    memoryScopeId,
    channelBindingId: null,
    status: conversationStatus,
    ...(searchTerm ? {
      OR: [
        { title: { contains: searchTerm, mode: "insensitive" as const } },
        { messages: { some: { content: { contains: searchTerm, mode: "insensitive" as const } } } },
      ],
    } : {}),
  };
  const conversations = await prisma.conversation.findMany({
    where: conversationWhere,
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: 50,
    select: { id: true, title: true, lastMessageAt: true, updatedAt: true, _count: { select: { messages: true } } },
  });
  /**
   * 指定的会话查不到就退回落列表第一条，不报错。
   *
   * 这个 id 来自浏览器 URL，过期是常态：会话刚被删掉、从归档视图点了旧链接、浏览器后退、
   * 或者在另一个标签页删过。以前这里抛 404，前端整页加载失败只剩一句报错；
   * 现在有了删除功能，这种情况只会更多。退回列表第一位，前端会把 URL 换成实际选中的那个。
   */
  const selectedConversation = (conversationId
    ? await prisma.conversation.findFirst({
        where: { id: conversationId, characterId, memoryScopeId, channelBindingId: null, status: conversationStatus },
        select: { id: true, title: true, lastMessageAt: true, updatedAt: true, _count: { select: { messages: true } } },
      })
    : null) ?? conversations[0] ?? null;
  if (selectedConversation && !conversations.some((conversation) => conversation.id === selectedConversation.id)) {
    conversations.unshift(selectedConversation);
    conversations.splice(20);
  }

  let messages: Array<{ id: string; role: string; content: string; occurredAt: Date; metadata: unknown }> = [];
  if (selectedConversation) {
    const descending = await prisma.message.findMany({
      where: { conversationId: selectedConversation.id },
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      take: 80,
      select: { id: true, role: true, content: true, occurredAt: true, metadata: true },
    });
    messages = descending.reverse();
  }

  const chatSettings = resolveChatModelSettings(character.modelConfig);
  return {
    character: {
      id: character.id,
      name: character.name,
      chatModel: chatSettings.model,
      chatTemperature: chatSettings.temperature,
      chatMaxTokens: chatSettings.maxTokens,
      chatApiBaseUrl: chatSettings.apiBaseUrl,
      chatApiKeyConfigured: chatSettings.apiKeyConfigured,
      chatApiKeySource: chatSettings.apiKeySource,
    },
    modelConfigured: Boolean(chatSettings.apiKeyConfigured && chatSettings.model),
    conversations: conversations.map((conversation) => ({
      id: conversation.id,
      title: conversation.title || "未命名对话",
      lastMessageAt: conversation.lastMessageAt,
      updatedAt: conversation.updatedAt,
      messageCount: conversation._count.messages,
    })),
    selectedConversationId: selectedConversation?.id ?? null,
    messages: messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      occurredAt: message.occurredAt,
      sources: message.role === "ASSISTANT" ? readStoredChatSources(message.metadata) : { memories: [], snapshots: [] },
    })),
  };
});
