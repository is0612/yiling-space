import { createError, getRouterParam, readBody } from "h3";
import { requireActorUserId } from "../../../../utils/auth";
import { readTrimmedString, requireUuid } from "../../../../utils/local-api";
import { getPrisma } from "../../../../utils/prisma";

export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const conversationId = requireUuid(getRouterParam(event, "conversationId") ?? "", "会话");
  const body = await readBody<Record<string, unknown>>(event);
  const hasStatus = body?.status !== undefined;
  const hasTitle = body?.title !== undefined;
  const rawRequestedStatus = body?.status;
  if (!hasStatus && !hasTitle) throw createError({ statusCode: 400, statusMessage: "请至少提供 status 或 title。" });
  if (hasStatus && rawRequestedStatus !== "ACTIVE" && rawRequestedStatus !== "ARCHIVED") {
    throw createError({ statusCode: 400, statusMessage: "status 只支持 ACTIVE 或 ARCHIVED。" });
  }
  const requestedStatus: "ACTIVE" | "ARCHIVED" | undefined =
    rawRequestedStatus === "ACTIVE" || rawRequestedStatus === "ARCHIVED" ? rawRequestedStatus : undefined;
  const requestedTitle = hasTitle ? readTrimmedString(body.title, "会话标题", 255, { required: true }) : undefined;

  const prisma = getPrisma();
  const character = await prisma.character.findFirst({
    where: { id: characterId, ownerId },
    select: {
      id: true,
      memoryScopes: { where: { scopeType: "CHARACTER_GLOBAL" }, select: { id: true }, take: 1 },
    },
  });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });
  const memoryScopeId = character.memoryScopes[0]?.id;
  if (!memoryScopeId) throw createError({ statusCode: 409, statusMessage: "该角色尚未建立全局记忆范围。" });

  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, characterId, memoryScopeId, channelBindingId: null },
    select: { id: true, title: true, status: true, updatedAt: true },
  });
  if (!conversation) throw createError({ statusCode: 404, statusMessage: "会话不存在或不属于当前角色。" });
  const statusChanged = requestedStatus !== undefined && conversation.status !== requestedStatus;
  const titleChanged = requestedTitle !== undefined && requestedTitle !== conversation.title;
  if (!statusChanged && !titleChanged) {
    return { id: conversation.id, title: conversation.title, status: conversation.status, updatedAt: conversation.updatedAt };
  }

  const updated = await prisma.$transaction(async (tx) => {
    const saved = await tx.conversation.update({
      where: { id: conversation.id },
      data: {
        ...(statusChanged && requestedStatus ? { status: requestedStatus } : {}),
        ...(titleChanged ? { title: requestedTitle } : {}),
      },
      select: { id: true, title: true, status: true, updatedAt: true },
    });
    if (statusChanged) {
      await tx.auditLog.create({
        data: {
          actorType: "USER",
          actorId: ownerId,
          characterId,
          action: requestedStatus === "ARCHIVED" ? "CONVERSATION_ARCHIVED" : "CONVERSATION_RESTORED",
          entityType: "Conversation",
          entityId: conversation.id,
          details: { from: conversation.status, to: requestedStatus ?? conversation.status },
        },
      });
    }
    if (titleChanged) {
      await tx.auditLog.create({
        data: {
          actorType: "USER",
          actorId: ownerId,
          characterId,
          action: "CONVERSATION_RENAMED",
          entityType: "Conversation",
          entityId: conversation.id,
          details: { from: conversation.title, to: requestedTitle },
        },
      });
    }
    return saved;
  });

  return updated;
});
