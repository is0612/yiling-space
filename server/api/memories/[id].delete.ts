import { createError, defineEventHandler, getRouterParam } from "h3";
import { requireActorUserId } from "../../utils/auth";
import { requireUuid } from "../../utils/local-api";
import { getPrisma } from "../../utils/prisma";

export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const memoryId = requireUuid(getRouterParam(event, "id") ?? "", "记忆");
  const prisma = getPrisma();

  const result = await prisma.$transaction(async (tx) => {
    // Hold the item lock through state validation, reference counting and deletion.
    await tx.$queryRaw`
      SELECT m.id FROM memory_items m
      JOIN memory_scopes s ON s.id = m."memoryScopeId"
      JOIN characters c ON c.id = s."characterId"
      WHERE m.id = ${memoryId}::uuid AND c."ownerId" = ${ownerId}::uuid
      FOR UPDATE OF m
    `;
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
