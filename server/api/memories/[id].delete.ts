import { createError, getRouterParam } from "h3";
import { requireActorUserId } from "../../utils/auth";
import { requireUuid } from "../../utils/local-api";
import { getPrisma } from "../../utils/prisma";

export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const memoryId = requireUuid(getRouterParam(event, "id") ?? "", "记忆");
  const prisma = getPrisma();

  const result = await prisma.$transaction(async (tx) => {
    const existing = await tx.memoryItem.findFirst({
      where: {
        id: memoryId,
        memoryScope: { is: { character: { is: { ownerId } } } },
      },
      select: { id: true, status: true },
    });
    if (!existing) throw createError({ statusCode: 404, statusMessage: "长期记忆不存在。" });
    if (existing.status !== "TRASHED") {
      throw createError({ statusCode: 409, statusMessage: "只能永久删除已经移入回收站的记忆条目。" });
    }
    const preservedSnapshotReferences = await tx.memorySnapshotSource.count({ where: { memoryItemId: memoryId } });
    // On delete, the FK becomes null while sourceRef and immutable snapshot copies are kept.
    await tx.memoryItem.delete({ where: { id: memoryId } });
    return { preservedSnapshotReferences };
  });

  return {
    id: memoryId,
    permanentlyDeleted: true,
    snapshotsPreserved: true,
    preservedSnapshotReferences: result.preservedSnapshotReferences,
  };
});
