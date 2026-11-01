import { createError, getRouterParam } from "h3";
import { requireAdminActor } from "../../../../utils/auth";
import { getPrisma } from "../../../../utils/prisma";
import { requireUuid } from "../../../../utils/local-api";

/**
 * 解绑外部身份：取消 VERIFIED 状态，清空 linkedUserId，回到 UNVERIFIED。
 * 该身份的私人记忆保留，但不再参与原绑定用户的检索。
 */
export default defineEventHandler(async (event) => {
  await requireAdminActor(event);
  const identityId = requireUuid(getRouterParam(event, "id") ?? "", "外部身份");

  const prisma = getPrisma();
  const identity = await prisma.externalIdentity.findUnique({ where: { id: identityId }, select: { id: true, platform: true, platformUid: true } });
  if (!identity) throw createError({ statusCode: 404, statusMessage: "外部身份不存在。" });

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.externalIdentity.update({
      where: { id: identityId },
      data: { status: "UNVERIFIED", linkedUserId: null, verifiedAt: null },
      select: { id: true, platform: true, platformUid: true, status: true },
    });
    await tx.auditLog.create({
      data: {
        actorType: "USER",
        action: "identity.unlinked",
        entityType: "ExternalIdentity",
        entityId: identityId,
        details: { platform: identity.platform, platformUid: identity.platformUid },
      },
    });
    return result;
  });

  return updated;
});
