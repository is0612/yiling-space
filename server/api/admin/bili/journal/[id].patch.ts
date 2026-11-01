import { createError, getRouterParam, readBody } from "h3";
import { requireAdminActor } from "../../../../utils/auth";
import { readTrimmedString, requireUuid } from "../../../../utils/local-api";
import { getPrisma } from "../../../../utils/prisma";

/** 编辑一条 B站 札记（直接改角色长期记忆里的 EVENT 条目）。 */
export default defineEventHandler(async (event) => {
  const admin = await requireAdminActor(event);
  const id = requireUuid(getRouterParam(event, "id") ?? "", "札记");
  const body = await readBody<Record<string, unknown>>(event);
  const content = readTrimmedString(body?.content, "札记内容", 2_000, { required: true });

  const prisma = getPrisma();
  const existing = await prisma.memoryItem.findFirst({
    where: {
      id,
      deletedAt: null,
      memoryScope: { is: { character: { is: { ownerId: admin.user.id } } } },
      OR: [
        { dedupeKey: { startsWith: "bili-duty:" } },
        { dedupeKey: { startsWith: "bili-journal:" } },
      ],
    },
    select: { id: true, memoryScope: { select: { characterId: true } } },
  });
  if (!existing) throw createError({ statusCode: 404, statusMessage: "找不到这条札记。" });

  const updated = await prisma.memoryItem.update({
    where: { id },
    data: { content },
    select: { id: true, content: true, dedupeKey: true, updatedAt: true },
  });
  await prisma.auditLog.create({
    data: {
      actorType: "USER",
      actorId: admin.user.id,
      characterId: existing.memoryScope.characterId,
      action: "bili.journal_updated",
      entityType: "MemoryItem",
      entityId: id,
    },
  }).catch(() => undefined);

  return {
    id: updated.id,
    content: updated.content,
    dedupeKey: updated.dedupeKey,
    updatedAt: updated.updatedAt.toISOString(),
  };
});
