import { createError, getRouterParam } from "h3";
import { requireAdminActor } from "../../../../../utils/auth";
import { requireUuid } from "../../../../../utils/local-api";
import { getPrisma } from "../../../../../utils/prisma";

/**
 * 解绑一个角色与一个渠道。
 *
 * `group_activities` 的 `channelBindingId` 没有外键（见 prisma/schema.prisma），
 * 绑定删了它不会跟着走 —— 解绑一次就在库里留一批指向死绑定的群活跃度行。
 * 顺带一起清掉，不然这些行既查不到也删不掉。
 *
 * 会话的 `channelBindingId` 是 SetNull，会自己变空，不用管。
 */
export default defineEventHandler(async (event) => {
  await requireAdminActor(event);
  const bindingId = requireUuid(getRouterParam(event, "bindingId") ?? "", "绑定");

  const prisma = getPrisma();
  const binding = await prisma.characterChannelBinding.findUnique({
    where: { id: bindingId },
    select: { id: true },
  });
  if (!binding) throw createError({ statusCode: 404, statusMessage: "绑定不存在。" });

  const purged = await prisma.$transaction(async (tx) => {
    const activities = await tx.groupActivity.deleteMany({ where: { channelBindingId: bindingId } });
    await tx.characterChannelBinding.delete({ where: { id: bindingId } });
    return { groupActivities: activities.count };
  });

  return { deleted: true, purged };
});
