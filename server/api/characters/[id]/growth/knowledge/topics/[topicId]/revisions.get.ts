import { createError, defineEventHandler, getRouterParam, getQuery } from "h3";
import { requireActorUserId } from "../../../../../../../utils/auth";
import { requireUuid } from "../../../../../../../utils/local-api";
import { getPrisma } from "../../../../../../../utils/prisma";
import { listKnowledgeTopicRevisions } from "../../../../../../../utils/knowledge-topic-history";

export default defineEventHandler(async event => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const topicId = requireUuid(getRouterParam(event, "topicId") ?? "", "主题");
  const prisma = getPrisma();
  const character = await prisma.character.findFirst({ where: { id: characterId, ownerId }, select: { id: true } });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });
  const rawLimit = getQuery(event).limit;
  const limit = rawLimit === undefined ? 50 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw createError({ statusCode: 400, statusMessage: "历史记录数量必须在 1–100 之间。" });
  }
  return listKnowledgeTopicRevisions(prisma, characterId, topicId, limit);
});
