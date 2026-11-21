/**
 * 她发过的说说也算她的经历。
 *
 * 以前只落在 `onebot_qzone_actions`（动作台账），聊天里她完全不知道「我发过一条
 * 关于雨的说说」。这里把**发布成功**的正文写成一条 ASSISTANT 消息，挂在角色全局范围
 * 的「空间」会话里，让周期快照 / 忆泡 / 检索都能看见它。
 *
 * 边界：
 *   1. 只写发布成功的，且只写**公开可见**的：好友可见/仅自己可见的正文不进群聊可读的全局记忆。
 *   2. 会话按「角色 + QQ 号」定位：同一个 QQ 挂两个角色时，各写各的，不串号。
 *   3. 幂等键是**空间动作 ID**（`onebot_qzone_actions.id`），不是 tid、也不是正文：
 *      tid 可能为空（协议端不回），正文相同的两次发布是两件真事，都不该被吞。
 *   4. 写失败只记日志、由 `backfill:qzone-posts` 补记；补记不会再发一次说说。
 */

import type { Prisma, PrismaClient } from "../../src/generated/prisma/client";

export const QZONE_CONVERSATION_PREFIX = "q:";

export function qzoneConversationKey(accountQq: string): string {
  return `${QZONE_CONVERSATION_PREFIX}${accountQq.trim()}`;
}

export type QzonePostMemoryInput = {
  characterId: string;
  accountQq: string;
  /** 空间动作 ID：幂等键。同一个动作重投多少次都只记一条。 */
  actionId: string;
  content: string;
  /** 可见范围（ugc_right）：只有 1（公开）才进全局记忆。 */
  visible?: number;
  occurredAt?: Date;
};

export type QzonePostMemorySkipReason =
  | "no_scope"
  | "empty_content"
  | "duplicate"
  | "no_account"
  | "no_action"
  | "not_public";

export async function recordQzonePostMemory(
  prisma: PrismaClient,
  input: QzonePostMemoryInput,
): Promise<{ recorded: boolean; reason?: QzonePostMemorySkipReason }> {
  const content = input.content.trim();
  if (!content) return { recorded: false, reason: "empty_content" };
  const accountQq = input.accountQq.trim();
  if (!accountQq) return { recorded: false, reason: "no_account" };
  const actionId = input.actionId.trim();
  if (!actionId) return { recorded: false, reason: "no_action" };
  // 好友可见（4）/ 仅自己（64）的正文不写进全局记忆：群聊读得到的东西不能比主人以为的更多。
  if ((input.visible ?? 1) !== 1) return { recorded: false, reason: "not_public" };

  return prisma.$transaction(async (tx) => {
    // NULL binding 不受现有会话 unique 保护；同角色/账号的创建与写消息必须串行。
    const lockKey = JSON.stringify(["qzone-memory", input.characterId, accountQq]);
    await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;

  const scope = await tx.memoryScope.findFirst({
    where: { characterId: input.characterId, scopeType: "CHARACTER_GLOBAL" },
    select: { id: true },
  });
  if (!scope) return { recorded: false, reason: "no_scope" };

  const externalConversationId = qzoneConversationKey(accountQq);
  // 归属按「角色 + QQ」：同一个号挂两个角色时各写各的，不能拿 externalConversationId 单独查。
  const existing = await tx.conversation.findFirst({
    where: { characterId: input.characterId, channelBindingId: null, externalConversationId },
    orderBy: { createdAt: "asc" },
    select: { id: true, memoryScopeId: true },
  });
  // 错挂私人范围或其他角色范围时拒绝写入，不静默改写历史会话归属。
  if (existing && existing.memoryScopeId !== scope.id) throw new Error("QZONE_MEMORY_SCOPE_MISMATCH");
  const conversation = existing ?? await tx.conversation.create({
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

  const externalMessageId = `qzone-action:${actionId}`;
  const duplicate = await tx.message.findFirst({
    where: { conversationId: conversation.id, OR: [
      { externalMessageId },
      // 兼容尚未写 externalMessageId 的旧消息。
      { metadata: { path: ["qzoneActionId"], equals: actionId } },
    ] },
    select: { id: true },
  });
  if (duplicate) return { recorded: false, reason: "duplicate" };

  const occurredAt = input.occurredAt ?? new Date();
  await tx.message.create({
    data: {
      conversationId: conversation.id,
      externalMessageId,
      role: "ASSISTANT",
      content,
      occurredAt,
      metadata: {
        source: "qzone",
        kind: "qzone",
        qzoneActionId: actionId,
      } satisfies Prisma.InputJsonObject,
    },
  });
  await tx.conversation.updateMany({
    where: { id: conversation.id, OR: [{ lastMessageAt: null }, { lastMessageAt: { lt: occurredAt } }] },
    data: { lastMessageAt: occurredAt },
  });
  return { recorded: true };
  });
}

/**
 * 补记：把「已经发布成功、但没写进消息链路」的说说补上。
 *
 * 只读 `onebot_qzone_actions` 里 PUBLISHED 的 POST，逐条走同一个 `recordQzonePostMemory`
 * （动作 ID 幂等，所以重复跑安全）。**不会重新发布**任何内容。
 */
export async function backfillQzonePostMemories(
  prisma: PrismaClient,
  input: { characterId?: string; connectionId?: string; apply: boolean; limit?: number },
): Promise<{ scanned: number; recorded: number; skipped: number; wouldRecord: Array<{ actionId: string; characterId: string | null; content: string }> }> {
  const actions = await prisma.onebotQzoneAction.findMany({
    where: {
      kind: "POST",
      status: "PUBLISHED",
      ...(input.connectionId ? { connectionId: input.connectionId } : {}),
      ...(input.characterId ? { characterId: input.characterId } : {}),
    },
    orderBy: [{ publishedAt: "desc" }, { createdAt: "desc" }],
    take: input.limit ?? 500,
    select: { id: true, characterId: true, content: true, visible: true, publishedAt: true, connectionId: true },
  });
  let recorded = 0;
  let skipped = 0;
  const wouldRecord: Array<{ actionId: string; characterId: string | null; content: string }> = [];
  for (const action of actions) {
    if (!action.characterId || action.visible !== 1) {
      skipped += 1;
      continue;
    }
    // 预演不写库：只判断「这条动作有没有对应的消息」。
    if (!input.apply) {
      const exists = await prisma.message.findFirst({
        where: {
          conversation: { characterId: action.characterId, externalConversationId: qzoneConversationKey(await readConnectionAccountQq(prisma, action.connectionId)) },
          metadata: { path: ["qzoneActionId"], equals: action.id },
        },
        select: { id: true },
      });
      if (exists) skipped += 1;
      else wouldRecord.push({ actionId: action.id, characterId: action.characterId, content: action.content.slice(0, 40) });
      continue;
    }
    const result = await recordQzonePostMemory(prisma, {
      characterId: action.characterId,
      accountQq: await readConnectionAccountQq(prisma, action.connectionId),
      actionId: action.id,
      content: action.content,
      visible: action.visible,
      occurredAt: action.publishedAt ?? undefined,
    });
    if (result.recorded) recorded += 1;
    else {
      skipped += 1;
      if (result.reason !== "duplicate") wouldRecord.push({ actionId: action.id, characterId: action.characterId, content: action.content.slice(0, 40) });
    }
  }
  return { scanned: actions.length, recorded, skipped, wouldRecord };
}

/** 连接上的小号 QQ：写记忆时要用它拼 `q:<QQ号>` 会话键。取法与 `configure.ts` 一致：先 metadata.qqNumber，再 platformAccountKey。 */
async function readConnectionAccountQq(prisma: PrismaClient, connectionId: string): Promise<string> {
  const connection = await prisma.platformConnection.findUnique({
    where: { id: connectionId },
    select: { metadata: true, platformAccountKey: true },
  });
  const metadata = (connection?.metadata ?? {}) as Record<string, unknown>;
  const fromMetadata = typeof metadata.qqNumber === "string" ? metadata.qqNumber.trim() : "";
  return (fromMetadata || connection?.platformAccountKey || "").trim();
}
