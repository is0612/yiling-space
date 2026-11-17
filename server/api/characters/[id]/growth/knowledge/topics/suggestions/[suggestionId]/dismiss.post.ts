import { createError, getRouterParam } from "h3";
import { requireActorUserId } from "../../../../../../../../utils/auth";
import { requireUuid } from "../../../../../../../../utils/local-api";
import { getPrisma } from "../../../../../../../../utils/prisma";
import { dismissKnowledgeTopicSuggestion } from "../../../../../../../../utils/knowledge-topic-suggestions";

export default defineEventHandler(async event => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const suggestionId = requireUuid(getRouterParam(event, "suggestionId") ?? "", "主题建议");
  const prisma = getPrisma();
  const character = await prisma.character.findFirst({ where: { id: characterId, ownerId }, select: { id: true } });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });
  return dismissKnowledgeTopicSuggestion(prisma, characterId, suggestionId);
});
