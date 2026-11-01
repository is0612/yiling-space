import { createError, getRouterParam } from "h3";
import { requireAdminActor } from "../../../../utils/auth";
import { requireUuid } from "../../../../utils/local-api";
import { getPrisma } from "../../../../utils/prisma";

/** 删除一条 B站 札记：软删除（进回收站），不物理抹掉来源。 */
export default defineEventHandler(async (event) => {
  const admin = await requireAdminActor(event);
  const id = requireUuid(getRouterParam(event, "id") ?? "", "札记");

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
    select: { id: true, status: true, memoryScope: { select: { characterId: true } } },
  });
  if (!existing) throw createError({ statusCode: 404, statusMessage: "找不到这条札记。" });

  await prisma.memoryItem.update({
    where: { id },
    data: { statusBeforeTrash: existing.status, status: "TRASHED", deletedAt: new Date() },
  });
  await prisma.auditLog.create({
    data: {
      actorType: "USER",
      actorId: admin.user.id,
      characterId: existing.memoryScope.characterId,
      action: "bili.journal_deleted",
      entityType: "MemoryItem",
      entityId: id,
    },
  }).catch(() => undefined);

  return { deleted: true };
});
