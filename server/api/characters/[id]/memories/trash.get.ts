import { createError, getRouterParam } from "h3";
import { requireActorUserId } from "../../../../utils/auth";
import { requireUuid } from "../../../../utils/local-api";
import { getPrisma } from "../../../../utils/prisma";

export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const prisma = getPrisma();
  const character = await prisma.character.findFirst({ where: { id: characterId, ownerId }, select: { id: true } });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });

  return prisma.memoryItem.findMany({
    where: { status: "TRASHED", memoryScope: { is: { characterId } } },
    orderBy: [{ deletedAt: "desc" }, { id: "desc" }],
    select: {
      id: true, category: true, content: true, status: true, statusBeforeTrash: true,
      deletedAt: true, createdAt: true, updatedAt: true,
    },
  });
});
