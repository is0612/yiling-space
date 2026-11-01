import { createError, readBody } from "h3";
import { requireAdminActor } from "../../../utils/auth";
import { getPrisma } from "../../../utils/prisma";
import { parseDutyInput } from "../../../utils/channel-adapter/bili/configure";

/**
 * 更新某个 B站连接的值班设置（duty），写入 PlatformConnection.metadata.duty。
 * 对应 bili-desk 的 POST /api/duty。值班设置字段与渠道创建时一致，
 * 前端把整份 duty 提交上来（或只提交要改的字段，这里与现有值合并）。
 */
export default defineEventHandler(async (event) => {
  await requireAdminActor(event);
  const body = await readBody<{ connectionId?: unknown; duty?: unknown }>(event);

  const connectionId = typeof body?.connectionId === "string" && body.connectionId.trim()
    ? body.connectionId.trim()
    : null;
  if (!connectionId) {
    throw createError({ statusCode: 400, statusMessage: "缺少连接 ID。" });
  }

  const prisma = getPrisma();

  // 读现有连接，确认是 bili 平台并拿到现有 duty 做合并。
  const existing = await prisma.platformConnection.findUnique({
    where: { id: connectionId },
    select: { id: true, platform: true, metadata: true },
  });
  if (!existing || existing.platform !== "bili") {
    throw createError({ statusCode: 404, statusMessage: "找不到该 B站 连接。" });
  }

  const metadata = (existing.metadata ?? {}) as Record<string, unknown>;
  const oldDuty = (metadata.duty && typeof metadata.duty === "object" ? metadata.duty : {}) as Record<string, unknown>;

  // 提交的 duty 覆盖到现有值之上（浅合并），再走 parseDutyInput 规范化。
  const submitted = (body?.duty && typeof body.duty === "object" ? body.duty : {}) as Record<string, unknown>;
  const merged = { ...oldDuty, ...submitted };
  const duty = parseDutyInput(merged);

  const updated = await prisma.platformConnection.update({
    where: { id: connectionId },
    data: { metadata: { ...metadata, duty } },
    select: { id: true, platform: true, displayName: true },
  });

  return {
    ok: true,
    connectionId: updated.id,
    displayName: updated.displayName,
    duty,
  };
});
