import { createError, getRouterParam, readBody } from "h3";
import { requireAdminActor } from "../../../../utils/auth";
import { getPrisma } from "../../../../utils/prisma";
import { requireUuid } from "../../../../utils/local-api";

/**
 * 验证并绑定一个外部身份到某个站内用户。绑定后，该外部身份的私人记忆将能被
 * 目标用户在对话检索中读取（跨平台身份打通）。这是显式人工动作，绝不做自动合并。
 */
export default defineEventHandler(async (event) => {
  await requireAdminActor(event);
  const identityId = requireUuid(getRouterParam(event, "id") ?? "", "外部身份");
  const body = await readBody<Record<string, unknown>>(event);
  const userId = requireUuid(typeof body?.userId === "string" ? body.userId : "", "用户");

  const prisma = getPrisma();

  const identity = await prisma.externalIdentity.findUnique({ where: { id: identityId }, select: { id: true, platform: true, platformUid: true, status: true } });
  if (!identity) throw createError({ statusCode: 404, statusMessage: "外部身份不存在。" });

  const targetUser = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, username: true } });
  if (!targetUser) throw createError({ statusCode: 404, statusMessage: "目标用户不存在。" });

  const now = new Date();
  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.externalIdentity.update({
      where: { id: identityId },
      data: { status: "VERIFIED", linkedUserId: userId, verifiedAt: now },
      select: { id: true, platform: true, platformUid: true, status: true, linkedUserId: true },
    });
    await tx.auditLog.create({
      data: {
        actorType: "USER",
        action: "identity.verified",
        entityType: "ExternalIdentity",
        entityId: identityId,
        details: { platform: identity.platform, platformUid: identity.platformUid, linkedUserId: userId, linkedUsername: targetUser.username },
      },
    });
    return result;
  });

  return updated;
});
