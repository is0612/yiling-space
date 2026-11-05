import { createError, getRouterParam } from "h3";
import { requireActorUserId } from "../../../../utils/auth";
import { requireUuid } from "../../../../utils/local-api";
import { getPrisma } from "../../../../utils/prisma";
import { toMemorySnapshotDtos } from "../../../../utils/memory-snapshot-dto";

export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const prisma = getPrisma();

  const character = await prisma.character.findFirst({
    where: { id: characterId, ownerId },
    select: {
      id: true,
      memorySetting: { select: { timezone: true } },
      memoryScopes: {
        where: { scopeType: "CHARACTER_GLOBAL" },
        select: {
          snapshots: {
            orderBy: [{ createdAt: "desc" }, { version: "desc" }],
            include: {
              reviews: {
                select: { changeIndex: true, decision: true, memoryItemId: true, outcome: true },
              },
              sources: {
                select: {
                  sourceType: true,
                  sourceRef: true,
                  message: {
                    select: {
                      id: true,
                      role: true,
                      eventType: true,
                      content: true,
                      occurredAt: true,
                      conversation: { select: { title: true } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });

  if (!character) {
    throw createError({ statusCode: 404, statusMessage: "角色不存在。" });
  }

  const snapshots = character.memoryScopes.flatMap((scope) => scope.snapshots);
  return toMemorySnapshotDtos(snapshots, character.memorySetting?.timezone || "Asia/Shanghai");
});
