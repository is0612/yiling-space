import { createError, defineEventHandler, getRouterParam, readBody } from "h3";
import { requireActorUserId } from "../../../../../../../utils/auth";
import { requireUuid } from "../../../../../../../utils/local-api";
import { getPrisma } from "../../../../../../../utils/prisma";
import { revertKnowledgeTopicOperation } from "../../../../../../../utils/knowledge-topic-history";

export default defineEventHandler(async event => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const topicId = requireUuid(getRouterParam(event, "topicId") ?? "", "主题");
  const prisma = getPrisma();
  const character = await prisma.character.findFirst({ where: { id: characterId, ownerId }, select: { id: true } });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });
  const body = await readBody<{ revisionId?: unknown; expectedRevision?: unknown }>(event);
  return revertKnowledgeTopicOperation(prisma, characterId, topicId, body ?? {});
});
