/**
 * 她发过的说说也算她的经历。
 *
 * 以前只落在 `onebot_qzone_actions`（动作台账），聊天里她完全不知道「我发过一条
 * 关于雨的说说」。这里把**发布成功**的正文写成一条 ASSISTANT 消息，挂在角色全局范围
 * 的「空间」会话里，让周期快照 / 忆泡 / 检索都能看见它。
 *
 * 三条边界：
 *   1. 只写发布成功的；草稿、失败、待确认都不写（那还没发生）。
 *   2. 会话 `externalConversationId` 用 `q:<QQ号>`、`channelBindingId` 留空 ——
 *      桌面端「我的对话」要求两个字段都为空，所以它不会混进她的聊天列表。
 *   3. 同一个 `tid` 只写一次：网关重投或主人重复确认都不该多出一条经历。
 */

import type { Prisma, PrismaClient } from "../../src/generated/prisma/client";

export const QZONE_CONVERSATION_PREFIX = "q:";

export function qzoneConversationKey(accountQq: string): string {
  return `${QZONE_CONVERSATION_PREFIX}${accountQq.trim()}`;
}

export type QzonePostMemoryInput = {
  characterId: string;
  accountQq: string;
  content: string;
  tid: string | null;
  occurredAt?: Date;
};

export async function recordQzonePostMemory(
  prisma: PrismaClient,
  input: QzonePostMemoryInput,
): Promise<{ recorded: boolean; reason?: "no_scope" | "empty_content" | "duplicate" | "no_account" }> {
  const content = input.content.trim();
  if (!content) return { recorded: false, reason: "empty_content" };
  const accountQq = input.accountQq.trim();
  if (!accountQq) return { recorded: false, reason: "no_account" };

  const scope = await prisma.memoryScope.findFirst({
    where: { characterId: input.characterId, scopeType: "CHARACTER_GLOBAL" },
    select: { id: true },
  });
  if (!scope) return { recorded: false, reason: "no_scope" };

  const externalConversationId = qzoneConversationKey(accountQq);
  const existing = await prisma.conversation.findFirst({
    where: { channelBindingId: null, externalConversationId },
    select: { id: true },
  });
  const conversation = existing ?? await prisma.conversation.create({
    data: {
      characterId: input.characterId,
      memoryScopeId: scope.id,
      channelBindingId: null,
      externalConversationId,
      title: `QQ空间 ${accountQq}`,
      metadata: { kind: "qzone", qq: accountQq },
    },
    select: { id: true },
  });

  // tid 为空时退化成「同一天同一条正文只写一次」，避免协议端不给 tid 时重复记录。
  const occurredAt = input.occurredAt ?? new Date();
  const tidKey = input.tid?.trim() || null;
  const duplicate = await prisma.message.findFirst({
    where: {
      conversationId: conversation.id,
      ...(tidKey
        ? { metadata: { path: ["qzoneTid"], equals: tidKey } }
        : { content, occurredAt: { gte: new Date(occurredAt.getTime() - 86_400_000) } }),
    },
    select: { id: true },
  });
  if (duplicate) return { recorded: false, reason: "duplicate" };

  await prisma.message.create({
    data: {
      conversationId: conversation.id,
      role: "ASSISTANT",
      content,
      occurredAt,
      metadata: { source: "qzone", kind: "qzone", ...(tidKey ? { qzoneTid: tidKey } : {}) } satisfies Prisma.InputJsonObject,
    },
  });
  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { lastMessageAt: occurredAt },
  });
  return { recorded: true };
}
