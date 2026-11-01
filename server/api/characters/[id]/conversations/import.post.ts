import { createError, getRouterParam, readBody } from "h3";
import { requireActorUserId } from "../../../../utils/auth";
import { requireUuid, readTrimmedString } from "../../../../utils/local-api";
import { getPrisma } from "../../../../utils/prisma";

type PreparedMessage = {
  role: "USER" | "ASSISTANT";
  content: string;
  occurredAt: Date;
  timestampEstimated: boolean;
};

export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const body = await readBody<Record<string, unknown>>(event);
  const titleInput = readTrimmedString(body?.title, "会话标题", 255);
  const rawMessages = body?.messages;

  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    throw createError({ statusCode: 400, statusMessage: "请至少提供一条对话消息。" });
  }
  if (rawMessages.length > 200) {
    throw createError({ statusCode: 400, statusMessage: "一次最多导入 200 条消息。" });
  }

  const now = new Date();
  const messages: PreparedMessage[] = rawMessages.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw createError({ statusCode: 400, statusMessage: `第 ${index + 1} 条消息格式无效。` });
    }
    const message = candidate as Record<string, unknown>;
    if (message.role !== "USER" && message.role !== "ASSISTANT") {
      throw createError({ statusCode: 400, statusMessage: `第 ${index + 1} 条消息的角色必须是 USER 或 ASSISTANT。` });
    }
    const content = readTrimmedString(message.content, `第 ${index + 1} 条消息`, 12000, { required: true });
    let occurredAt: Date;
    let timestampEstimated = true;
    if (message.occurredAt === undefined || message.occurredAt === null || message.occurredAt === "") {
      // Millisecond offsets preserve input order without pretending the transcript has original timestamps.
      occurredAt = new Date(now.getTime() - (rawMessages.length - index - 1));
    } else if (typeof message.occurredAt === "string" && Number.isFinite(Date.parse(message.occurredAt))) {
      occurredAt = new Date(message.occurredAt);
      timestampEstimated = false;
    } else {
      throw createError({ statusCode: 400, statusMessage: `第 ${index + 1} 条消息的时间戳无效。` });
    }
    return { role: message.role, content, occurredAt, timestampEstimated };
  });

  const prisma = getPrisma();
  const character = await prisma.character.findFirst({
    where: { id: characterId, ownerId },
    select: {
      id: true,
      memoryScopes: {
        where: { scopeType: "CHARACTER_GLOBAL" },
        select: { id: true },
        take: 1,
      },
    },
  });
  if (!character) {
    throw createError({ statusCode: 404, statusMessage: "角色不存在。" });
  }

  const memoryScopeId = character.memoryScopes[0]?.id;
  if (!memoryScopeId) {
    throw createError({ statusCode: 409, statusMessage: "该角色还没有全局记忆范围，请先重新保存角色档案。" });
  }

  const lastMessageAt = messages.reduce(
    (latest, message) => message.occurredAt > latest ? message.occurredAt : latest,
    messages[0]!.occurredAt,
  );
  const estimatedTimestamps = messages.some((message) => message.timestampEstimated);
  const conversationTitle = titleInput || `手动录入对话 ${now.toISOString().slice(0, 16).replace("T", " ")} UTC`;

  const result = await prisma.$transaction(async (tx) => {
    const conversation = await tx.conversation.create({
      data: {
        characterId,
        memoryScopeId,
        title: conversationTitle,
        lastMessageAt,
        metadata: {
          importMethod: "manual-transcript",
          timestampsEstimated: estimatedTimestamps,
        },
      },
      select: { id: true, title: true },
    });
    const inserted = await tx.message.createMany({
      data: messages.map((message, index) => ({
        conversationId: conversation.id,
        role: message.role,
        eventType: "message",
        content: message.content,
        occurredAt: message.occurredAt,
        metadata: {
          importMethod: "manual-transcript",
          importIndex: index,
          timestampEstimated: message.timestampEstimated,
        },
      })),
    });
    return { conversationId: conversation.id, title: conversation.title, messageCount: inserted.count };
  });

  setResponseStatus(event, 201);
  return { ...result, timestampsEstimated: estimatedTimestamps };
});
