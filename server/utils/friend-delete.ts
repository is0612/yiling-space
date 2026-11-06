import { tombstoneDesktopConversationRequests } from "./desktop-conversation";
import { getPrisma } from "./prisma";

/**
 * 删掉「某个角色认识的某个人」这条关系。
 *
 * 关系直接落在 `MemoryScope(EXTERNAL_IDENTITY)` 上，所以删的就是这一条 scope。
 * 单独抽出来是因为删除顺序最容易出错，而且这个操作只有一份语义（接口和清理脚本要用同一条）。
 *
 * 顺序：
 *   1. `Conversation.memoryScope → Restrict`（**不是** Cascade），必须先显式删，
 *      否则第 3 步删 scope 会被外键挡住。删之前按桌面会话那套 tombstone 一次 idempotency 行，
 *      否则删完还能用旧 requestKey 重放，凭空长出一段新会话。
 *   2. `Message` / `GroupMember` / 会话下的 `MemoryEvent` → 随会话 Cascade。
 *   3. `MemoryItem` / `MemorySnapshot` / `MemoryEvent` / `MemoryEventDay` / `MemoryJob` /
 *      `CharacterJournal` / `FriendAliasSuggestion` → 随 scope Cascade。
 *   4. `MemoryItem.sourceMessageId` / `MemorySnapshotSource.messageId` → SetNull，不会挡路。
 *
 * 故意**不删**的：
 *   - `ExternalIdentity`：`(platform, platformUid)` 全局唯一，同一个 QQ 号可能同时是几个角色的朋友，
 *     删掉一个角色的关系不该连带另一个角色。
 *   - 群会话与 `GroupMember`：那个人在群里说过话是群级事实，群会话挂在群 scope 上，不在这条关系里。
 *   - `ModelUsage`：token 账单不因为删关系而消失（与删角色同一口径）。
 *   - `AuditLog`：留一条 `FRIEND_DELETED`，记下删的是谁、带走多少行。
 *
 * 也不是永久的：对方下次再来，`ensureExternalIdentityScope` 会按同一个 `scopeKey` 重建一条空关系，
 * 从 0 开始计数 —— 旧对话和旧记忆不会再回来。
 *
 * 找不到、或者 id 指向的不是外部身份范围时返回 `null`，由调用方决定报什么错。
 */
export type FriendDeleteSummary = {
  conversations: number;
  messages: number;
  memoryItems: number;
  snapshots: number;
  events: number;
  /** 待审备注：一起删掉，不然弹窗里会剩下指向空关系的条目。 */
  suggestions: number;
};

export type FriendDeleteOutcome = {
  scopeId: string;
  characterId: string;
  platform: string;
  platformUid: string;
  displayName: string | null;
  deleted: FriendDeleteSummary;
};

export async function deleteFriendScope(input: {
  scopeId: string;
  /** 写进审计；本地开发身份也有 userId，正常不会为空。 */
  actorId: string | null;
}): Promise<FriendDeleteOutcome | null> {
  const prisma = getPrisma();
  const { scopeId, actorId } = input;

  return prisma.$transaction(async (tx) => {
    const scope = await tx.memoryScope.findUnique({
      where: { id: scopeId },
      select: {
        id: true,
        characterId: true,
        scopeType: true,
        interactionCount: true,
        externalIdentity: { select: { platform: true, platformUid: true, displayName: true } },
      },
    });
    if (!scope || scope.scopeType !== "EXTERNAL_IDENTITY" || !scope.externalIdentity) return null;

    // 数量在删之前数：删完就查不到了，而这些数字要给审计和前端看「带走了多少」。
    const [conversations, memoryItems, snapshots, events, suggestions] = await Promise.all([
      tx.conversation.findMany({
        where: { memoryScopeId: scope.id },
        select: { id: true, _count: { select: { messages: true } } },
      }),
      tx.memoryItem.count({ where: { memoryScopeId: scope.id } }),
      tx.memorySnapshot.count({ where: { memoryScopeId: scope.id } }),
      tx.memoryEvent.count({ where: { memoryScopeId: scope.id } }),
      tx.friendAliasSuggestion.count({ where: { scopeId: scope.id } }),
    ]);

    for (const conversation of conversations) {
      // 与桌面删会话同一套顺序：先拿行锁（update 会锁住这一行），再 tombstone，最后删。
      // 不锁的话，正在跑的那一轮回复可能在删完之后又写回一条消息。
      await tx.conversation.update({ where: { id: conversation.id }, data: { updatedAt: new Date() } });
      await tombstoneDesktopConversationRequests(tx, conversation.id);
    }

    const deleted: FriendDeleteSummary = {
      conversations: conversations.length,
      messages: conversations.reduce((sum, item) => sum + item._count.messages, 0),
      memoryItems,
      snapshots,
      events,
      suggestions,
    };

    await tx.conversation.deleteMany({ where: { memoryScopeId: scope.id } });
    await tx.memoryScope.delete({ where: { id: scope.id } });

    await tx.auditLog.create({
      data: {
        actorType: "USER",
        actorId,
        characterId: scope.characterId,
        action: "FRIEND_DELETED",
        entityType: "MemoryScope",
        entityId: scope.id,
        details: {
          platform: scope.externalIdentity.platform,
          platformUid: scope.externalIdentity.platformUid,
          displayName: scope.externalIdentity.displayName,
          interactionCount: scope.interactionCount,
          ...deleted,
        },
      },
    });

    return {
      scopeId: scope.id,
      characterId: scope.characterId,
      platform: scope.externalIdentity.platform,
      platformUid: scope.externalIdentity.platformUid,
      displayName: scope.externalIdentity.displayName,
      deleted,
    };
  });
}
