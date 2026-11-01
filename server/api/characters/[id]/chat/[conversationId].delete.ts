import { createError, getRouterParam } from "h3";
import { requireActorUserId } from "../../../../utils/auth";
import { requireUuid } from "../../../../utils/local-api";
import { getPrisma } from "../../../../utils/prisma";

/**
 * 删除一段桌面端 AI 对话。
 *
 * 「删对话不删记忆」是硬要求，靠 schema 保证，不靠这里写补偿逻辑：
 *   - Message.conversation → onDelete: Cascade　删会话带走消息（这是想要的）
 *   - MemoryItem.sourceMessageId → onDelete: SetNull　记忆条目留着，只丢「从哪条消息来的」指针
 *   - MemorySnapshotSource.messageId → onDelete: SetNull　快照留着，同样只丢指针
 *
 * 记忆属于 MemoryScope，不挂在 Conversation 下面，所以会话没了记忆也不会跟着走。
 * 删之前先把「有多少记忆是这段对话沉淀出来的」数出来带回前端 —— 人看不到数字就容易
 * 以为一起删了，然后去记忆页找。
 */
export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const conversationId = requireUuid(getRouterParam(event, "conversationId") ?? "", "会话");
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

  // channelBindingId: null 与前几个接口同一套边界：QQ 等渠道的记录只在渠道侧处理。
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, characterId, memoryScopeId, channelBindingId: null },
    select: { id: true, title: true, status: true, _count: { select: { messages: true } } },
  });
  if (!conversation) throw createError({ statusCode: 404, statusMessage: "会话不存在或不属于当前角色。" });

  // 用关系过滤而不是先取 message id 列表：长会话几千条时 IN (...) 参数会顶到上限。
  // TRASHED 的不计入：它们已经在回收站里，跟「记忆页还能看到的东西」不是一回事。
  const [retainedMemories, retainedSnapshotSources] = await Promise.all([
    prisma.memoryItem.count({
      where: { sourceMessage: { conversationId: conversation.id }, status: { not: "TRASHED" } },
    }),
    prisma.memorySnapshotSource.count({
      where: { message: { conversationId: conversation.id } },
    }),
  ]);

  await prisma.$transaction(async (tx) => {
    await tx.conversation.delete({ where: { id: conversation.id } });
    await tx.auditLog.create({
      data: {
        actorType: "USER",
        actorId: ownerId,
        characterId,
        action: "CONVERSATION_DELETED",
        entityType: "Conversation",
        entityId: conversation.id,
        details: {
          title: conversation.title,
          previousStatus: conversation.status,
          messageCount: conversation._count.messages,
          retainedMemories,
          retainedSnapshotSources,
        },
      },
    });
  });

  return {
    ok: true,
    id: conversation.id,
    title: conversation.title,
    deletedMessages: conversation._count.messages,
    // 和 memories/[id].delete 一个口径：显式表态「记忆侧没动」，别让人靠数字倒推。
    memoriesPreserved: true,
    retainedMemories,
    retainedSnapshotSources,
  };
});
