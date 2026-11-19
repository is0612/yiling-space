import { getPrisma } from "./prisma";

/**
 * 删掉一个渠道连接（「删除这个号」）的完整语义。
 *
 * 为什么先清绑定：`character_channel_bindings.connectionId` 是 `onDelete: Restrict`，
 * 只要号上还挂着任何一个角色，直接删连接就会被外键挡下来，前端只能看到
 * 「删除失败，请稍后重试」—— 也就是「加了一个角色进来之后这个号就再也删不掉了」。
 *
 * 顺序和 `character-delete.ts` 同一套：
 *
 *   A. 没有外键的必须手动删（否则留下查不到也删不掉的孤儿行）
 *      - GroupActivity：按绑定 id 删 —— 绑定没了，这些活跃度行永远读不到
 *      - OnebotGroupAnnouncement / OnebotQzoneAction：只带 connectionId，没有 relation
 *   B. 有外键的交给数据库
 *      - CharacterChannelBinding → 绑定相关的会话与记录级联删
 *      - Conversation / ModelUsage 的 `channelBindingId` 是 SetNull：聊天记录和账单**保留**，
 *        号没了不等于那段时间的对话该消失
 *      - ExternalIdentity.connectionId → SetNull
 *
 * 抽在这里而不是塞进 handler：删号漏一张表不会报错、只会悄悄留孤儿行，
 * 这种语义要能被脚本测到，而不是起一个 Nuxt 再手点。
 */

export type ChannelConnectionDeleteResult = {
  /** 被一起清掉的绑定数（= 这个号上挂过几个角色）。 */
  bindings: number;
  groupActivities: number;
  announcements: number;
  qzoneActions: number;
};

type DeleteManyArgs = { where: Record<string, unknown> };
type DeleteMany = { deleteMany(args: DeleteManyArgs): Promise<{ count: number }> };

export type ChannelConnectionDeleteTransaction = {
  characterChannelBinding: DeleteMany & {
    findMany(args: { where: { connectionId: string }; select: { id: true } }): Promise<Array<{ id: string }>>;
  };
  groupActivity: DeleteMany;
  onebotGroupAnnouncement: DeleteMany;
  onebotQzoneAction: DeleteMany;
  platformConnection: { delete(args: { where: { id: string } }): Promise<unknown> };
};

type ChannelConnectionDeleteDatabase = {
  $transaction<T>(run: (tx: ChannelConnectionDeleteTransaction) => Promise<T>): Promise<T>;
};

export async function deleteChannelConnectionCompletely(
  options: { connectionId: string },
  dependencies: { prisma?: ChannelConnectionDeleteDatabase } = {},
): Promise<ChannelConnectionDeleteResult> {
  const prisma: ChannelConnectionDeleteDatabase = dependencies.prisma ?? getPrisma();
  const { connectionId } = options;

  return prisma.$transaction(async (tx) => {
    const bindings = await tx.characterChannelBinding.findMany({
      where: { connectionId },
      select: { id: true },
    });
    const bindingIds = bindings.map((item) => item.id);

    const groupActivities = bindingIds.length
      ? await tx.groupActivity.deleteMany({ where: { channelBindingId: { in: bindingIds } } })
      : { count: 0 };
    const announcements = await tx.onebotGroupAnnouncement.deleteMany({ where: { connectionId } });
    const qzoneActions = await tx.onebotQzoneAction.deleteMany({ where: { connectionId } });
    const removedBindings = await tx.characterChannelBinding.deleteMany({ where: { connectionId } });
    await tx.platformConnection.delete({ where: { id: connectionId } });

    return {
      bindings: removedBindings.count,
      groupActivities: groupActivities.count,
      announcements: announcements.count,
      qzoneActions: qzoneActions.count,
    };
  });
}
