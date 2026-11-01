import { createError, readBody } from "h3";
import { requireAdminActor } from "../../../../utils/auth";
import { getPrisma } from "../../../../utils/prisma";
import { parseDutyInput } from "../../../../utils/channel-adapter/bili/configure";

/**
 * 重置某个 B站 连接「今天的额度」：把 quotaResetAt 设为当前时间。
 * 报告和判重都不删，只是早于这个时间的报告不再计入今天已挑条数；
 * 因此历史仍然可查，值班台和调度会从 0 开始算今天的剩余额度。
 */
export default defineEventHandler(async (event) => {
  const admin = await requireAdminActor(event);
  const body = await readBody<{ connectionId?: unknown }>(event);
  const connectionId = typeof body?.connectionId === "string" ? body.connectionId.trim() : "";
  if (!connectionId) throw createError({ statusCode: 400, statusMessage: "缺少连接 ID。" });

  const prisma = getPrisma();
  const existing = await prisma.platformConnection.findUnique({
    where: { id: connectionId },
    select: { id: true, platform: true, metadata: true },
  });
  if (!existing || existing.platform !== "bili") {
    throw createError({ statusCode: 404, statusMessage: "找不到该 B站 连接。" });
  }

  const metadata = (existing.metadata && typeof existing.metadata === "object" ? existing.metadata : {}) as Record<string, unknown>;
  const oldDuty = (metadata.duty && typeof metadata.duty === "object" ? metadata.duty : {}) as Record<string, unknown>;
  const quotaResetAt = new Date().toISOString();
  const duty = parseDutyInput({ ...oldDuty, quotaResetAt });

  await prisma.platformConnection.update({
    where: { id: connectionId },
    data: { metadata: { ...metadata, duty } },
  });
  await prisma.auditLog.create({
    data: {
      actorType: "USER",
      actorId: admin.user.id,
      action: "bili.duty_quota_reset",
      entityType: "PlatformConnection",
      entityId: connectionId,
      details: { quotaResetAt },
    },
  }).catch(() => undefined);

  return { ok: true, quotaResetAt, duty };
});
