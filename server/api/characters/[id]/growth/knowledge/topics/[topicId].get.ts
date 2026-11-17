import { createError, defineEventHandler, getRouterParam } from "h3";
import { requireActorUserId } from "../../../../../../utils/auth";
import { requireUuid } from "../../../../../../utils/local-api";
import { getPrisma } from "../../../../../../utils/prisma";

export default defineEventHandler(async event => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const topicId = requireUuid(getRouterParam(event, "topicId") ?? "", "主题");
  const prisma = getPrisma();
  const character = await prisma.character.findFirst({ where: { id: characterId, ownerId }, select: { id: true } });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });

  const topic = await prisma.knowledgeTopic.findFirst({
    where: { id: topicId, characterId },
    include: {
      members: {
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        include: {
          item: {
            select: {
              id: true, characterId: true, title: true, content: true, category: true, tags: true,
              status: true, revision: true, updatedAt: true,
            },
          },
        },
      },
      revisions: {
        orderBy: [{ revision: "desc" }],
        take: 20,
        select: { id: true, revision: true, name: true, description: true, status: true, mergedIntoId: true, createdAt: true },
      },
      mergedInto: { select: { id: true, name: true, status: true } },
    },
  });
  if (!topic) throw createError({ statusCode: 404, statusMessage: "主题不存在。" });

  return {
    topic: {
      id: topic.id, name: topic.name, description: topic.description, status: topic.status,
      revision: topic.revision, mergedIntoId: topic.mergedIntoId, mergedAt: topic.mergedAt,
      mergedInto: topic.mergedInto, createdAt: topic.createdAt, updatedAt: topic.updatedAt,
      members: topic.members.map(member => ({
        id: member.id, itemId: member.itemId, itemRevision: member.itemRevision, createdAt: member.createdAt,
        valid: member.item.characterId === characterId && member.item.status === "ACTIVE",
        itemRevisionChanged: member.item.characterId === characterId && member.item.revision !== member.itemRevision,
        invalidReason: member.item.characterId !== characterId ? "NOT_IN_CHARACTER"
          : member.item.status === "ACTIVE" ? null : member.item.status,
        item: member.item.characterId === characterId ? {
          id: member.item.id, title: member.item.title, content: member.item.content,
          category: member.item.category, tags: member.item.tags, status: member.item.status,
          revision: member.item.revision, updatedAt: member.item.updatedAt,
        } : null,
      })),
      revisions: topic.revisions,
    },
  };
});
