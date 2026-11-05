import { createError } from "h3";
import { Prisma } from "../../src/generated/prisma/client";

/** The desktop chat boundary: external channel conversations have both fields populated. */
export const DESKTOP_CONVERSATION_WHERE = {
  channelBindingId: null,
  externalConversationId: null,
} as const;

/** Stored on a request row after its target desktop conversation is deleted. */
export const DELETED_DESKTOP_CONVERSATION_REQUEST_ERROR = "CHAT_CONVERSATION_DELETED";

export function desktopConversationWhere(
  where: Prisma.ConversationWhereInput = {},
): Prisma.ConversationWhereInput {
  return { ...where, ...DESKTOP_CONVERSATION_WHERE };
}

export function throwDeletedDesktopConversationRequest(): never {
  throw createError({
    statusCode: 409,
    statusMessage: "该聊天请求对应的会话已删除，请使用新的 requestKey 重新发送。",
  });
}

export type DesktopConversationWriteTx = Prisma.TransactionClient;

/** Archive keeps history readable; deletion and a detached channel target forbid replay. */
export async function validateDesktopConversationReplay(
  db: Pick<DesktopConversationWriteTx, "conversation">,
  input: { conversationId: string | null; characterId: string; memoryScopeId: string | null },
): Promise<void> {
  if (!input.conversationId || !input.memoryScopeId) throwDeletedDesktopConversationRequest();
  const target = await db.conversation.findFirst({
    where: desktopConversationWhere({
      id: input.conversationId, characterId: input.characterId, memoryScopeId: input.memoryScopeId,
    }),
    select: { id: true },
  });
  if (!target) throwDeletedDesktopConversationRequest();
}

/** Retain request keys so replay cannot recreate deleted new conversations. */
export async function tombstoneDesktopConversationRequests(
  tx: DesktopConversationWriteTx,
  conversationId: string,
): Promise<void> {
  await tx.chatRequest.updateMany({
    where: { conversationId },
    data: {
      status: "FAILED",
      response: Prisma.JsonNull,
      lastError: DELETED_DESKTOP_CONVERSATION_REQUEST_ERROR,
    },
  });
}

/**
 * Revalidates and locks an existing desktop conversation before appending messages.
 * Updating lastMessageAt is deliberate: PostgreSQL takes a row lock before messages
 * are inserted, so an archive/delete racing this transaction cannot commit first.
 */
export async function lockActiveDesktopConversationForWrite(
  tx: DesktopConversationWriteTx,
  input: { id: string; characterId: string; memoryScopeId: string; lastMessageAt: Date },
): Promise<void> {
  const locked = await tx.conversation.updateMany({
    where: desktopConversationWhere({
      id: input.id,
      characterId: input.characterId,
      memoryScopeId: input.memoryScopeId,
      status: "ACTIVE",
    }),
    data: { lastMessageAt: input.lastMessageAt },
  });
  if (locked.count !== 1) {
    throw createError({
      statusCode: 409,
      statusMessage: "会话已归档或删除，无法继续写入；请刷新后重试。",
    });
  }
}
