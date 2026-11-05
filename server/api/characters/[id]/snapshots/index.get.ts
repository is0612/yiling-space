import { createError, getRouterParam } from "h3";
import { requireActorUserId } from "../../../../utils/auth";
import { requireUuid } from "../../../../utils/local-api";
import { getPrisma } from "../../../../utils/prisma";
import { toMemorySnapshotDtos } from "../../../../utils/memory-snapshot-dto";
import { describeMemoryScope } from "../../../../utils/memory-scope-label";

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
        /**
         * 不再只看 CHARACTER_GLOBAL：群聊和私聊挂在 EXTERNAL_IDENTITY 范围上，
         * 只查全局的话，16000 条群消息对应的总结在页面上根本不出现。
         */
        select: {
          id: true,
          scopeType: true,
          scopeKey: true,
          conversations: {
            orderBy: { lastMessageAt: "desc" },
            take: 3,
            select: { externalConversationId: true, title: true },
          },
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

  const snapshots = character.memoryScopes.flatMap((scope) => {
    const scopeLabel = describeMemoryScope(scope);
    return scope.snapshots.map((snapshot) => ({ ...snapshot, scopeLabel }));
  });
  return toMemorySnapshotDtos(snapshots, character.memorySetting?.timezone || "Asia/Shanghai");
});
