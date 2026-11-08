import { createError, getRouterParam } from "h3";
import { requireActorUserId } from "../../../../../../../utils/auth";
import { requireUuid } from "../../../../../../../utils/local-api";
import { getPrisma } from "../../../../../../../utils/prisma";

export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const itemId = requireUuid(getRouterParam(event, "itemId") ?? "", "正式知识");
  const prisma = getPrisma();
  const character = await prisma.character.findFirst({ where: { id: characterId, ownerId }, select: { id: true } });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });

  const item = await prisma.knowledgeItem.findFirst({
    where: { id: itemId, characterId },
    select: { id: true, revision: true },
  });
  if (!item) throw createError({ statusCode: 404, statusMessage: "正式知识不存在。" });

  const revisions = await prisma.knowledgeItemRevision.findMany({
    where: { itemId: item.id },
    orderBy: { revision: "desc" },
    select: {
      id: true, revision: true, title: true, content: true, category: true,
      tags: true, confidence: true, status: true, sourceType: true, sourceRef: true, createdAt: true,
    },
  });
  return { itemId: item.id, currentRevision: item.revision, revisions };
});
