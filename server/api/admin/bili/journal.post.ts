import { randomUUID } from "node:crypto";
import { createError, readBody } from "h3";
import { requireAdminActor } from "../../../utils/auth";
import { readTrimmedString, requireUuid } from "../../../utils/local-api";
import { getPrisma } from "../../../utils/prisma";

/** 手工补一条札记：写进角色长期记忆，和 B站 值班自动写的札记同一类。 */
export default defineEventHandler(async (event) => {
  const admin = await requireAdminActor(event);
  const body = await readBody<Record<string, unknown>>(event);
  const connectionId = requireUuid(readTrimmedString(body?.connectionId, "B站连接", 100, { required: true }), "B站连接");
  const bindingId = requireUuid(readTrimmedString(body?.bindingId, "角色绑定", 100, { required: true }), "角色绑定");
  const content = readTrimmedString(body?.content, "札记内容", 2_000, { required: true });

  const prisma = getPrisma();
  const connection = await prisma.platformConnection.findFirst({
    where: { id: connectionId, platform: "bili" },
    select: { id: true },
  });
  if (!connection) throw createError({ statusCode: 404, statusMessage: "找不到该 B站 连接。" });

  const binding = await prisma.characterChannelBinding.findFirst({
    where: { id: bindingId, connectionId, status: "ACTIVE" },
    select: { characterId: true },
  });
  if (!binding) throw createError({ statusCode: 404, statusMessage: "该连接下没有这个角色绑定。" });

  const scope = await prisma.memoryScope.findFirst({
    where: { characterId: binding.characterId, scopeType: "CHARACTER_GLOBAL" },
    select: { id: true },
  });
  if (!scope) throw createError({ statusCode: 409, statusMessage: "角色缺少全局记忆范围。" });

  const entry = await prisma.memoryItem.create({
    data: {
      memoryScopeId: scope.id,
      category: "EVENT",
      content,
      confidence: 1,
      dedupeKey: `bili-journal:${bindingId}:${randomUUID()}`,
      validFrom: new Date(),
    },
    select: { id: true, content: true, dedupeKey: true, updatedAt: true },
  });
  await prisma.auditLog.create({
    data: {
      actorType: "USER",
      actorId: admin.user.id,
      characterId: binding.characterId,
      action: "bili.journal_created",
      entityType: "MemoryItem",
      entityId: entry.id,
      details: { connectionId, bindingId },
    },
  }).catch(() => undefined);

  return {
    id: entry.id,
    content: entry.content,
    dedupeKey: entry.dedupeKey,
    updatedAt: entry.updatedAt.toISOString(),
  };
});
