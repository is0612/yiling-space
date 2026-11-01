import { createError, getRouterParam } from "h3";
import { requireAdminActor } from "../../../../utils/auth";
import { getPrisma } from "../../../../utils/prisma";
import { requireUuid } from "../../../../utils/local-api";

/**
 * 撤销外部身份：标记为 REVOKED。其私人记忆保留（可追溯），但不再参与任何检索。
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
      data: { status: "REVOKED", linkedUserId: null },
      select: { id: true, platform: true, platformUid: true, status: true },
    });
    await tx.auditLog.create({
      data: {
        actorType: "USER",
        action: "identity.revoked",
        entityType: "ExternalIdentity",
        entityId: identityId,
        details: { platform: identity.platform, platformUid: identity.platformUid },
      },
    });
    return result;
  });

  return updated;
});
