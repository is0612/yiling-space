import { createError, getQuery } from "h3";
import { requireAdminActor } from "../../../utils/auth";
import { requireUuid } from "../../../utils/local-api";
import { getPrisma } from "../../../utils/prisma";

/**
 * 「她的札记」：B站 值班写进角色长期记忆的 EVENT 条目。
 * 只读这里，编辑/新增走 journal.post / journal/[id].patch / delete。
 */
export default defineEventHandler(async (event) => {
  await requireAdminActor(event);
  const query = getQuery(event);
  const connectionId = requireUuid(String(query.connectionId ?? ""), "B站连接");
  const bindingId = requireUuid(String(query.bindingId ?? ""), "角色绑定");

  const prisma = getPrisma();
  const connection = await prisma.platformConnection.findFirst({
    where: { id: connectionId, platform: "bili" },
    select: { id: true },
  });
  if (!connection) throw createError({ statusCode: 404, statusMessage: "找不到该 B站 连接。" });

  const binding = await prisma.characterChannelBinding.findFirst({
    where: { id: bindingId, connectionId, status: "ACTIVE" },
    select: { characterId: true, character: { select: { name: true } } },
  });
  if (!binding) throw createError({ statusCode: 404, statusMessage: "该连接下没有这个角色绑定。" });

  const scope = await prisma.memoryScope.findFirst({
    where: { characterId: binding.characterId, scopeType: "CHARACTER_GLOBAL" },
    select: { id: true },
  });
  if (!scope) throw createError({ statusCode: 409, statusMessage: "角色缺少全局记忆范围。" });

  const entries = await prisma.memoryItem.findMany({
    where: {
      memoryScopeId: scope.id,
      deletedAt: null,
      OR: [
        { dedupeKey: { startsWith: `bili-duty:${bindingId}:` } },
        { dedupeKey: { startsWith: `bili-journal:${bindingId}:` } },
      ],
    },
    orderBy: { updatedAt: "desc" },
    take: 100,
    select: { id: true, content: true, dedupeKey: true, updatedAt: true },
  });

  return {
    characterName: binding.character.name,
    entries: entries.map((entry) => ({
      id: entry.id,
      content: entry.content,
      dedupeKey: entry.dedupeKey,
      updatedAt: entry.updatedAt.toISOString(),
    })),
  };
});
