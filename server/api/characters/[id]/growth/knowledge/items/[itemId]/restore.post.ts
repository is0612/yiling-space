import { createError, defineEventHandler, getRouterParam, readBody } from "h3";
import { requireActorUserId } from "../../../../../../../utils/auth";
import { requireUuid } from "../../../../../../../utils/local-api";
import { getPrisma } from "../../../../../../../utils/prisma";
import { applyKnowledgeLifecycle, KNOWLEDGE_LIFECYCLE_RULES, parseLifecycleBody } from "../../../../../../../utils/knowledge-lifecycle";

/** TRASHED → ACTIVE：从回收站恢复。 */
export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const itemId = requireUuid(getRouterParam(event, "itemId") ?? "", "正式知识");
  const prisma = getPrisma();
  const character = await prisma.character.findFirst({ where: { id: characterId, ownerId }, select: { id: true } });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });

  const { expectedRevision } = parseLifecycleBody(await readBody(event));
  const item = await prisma.$transaction(tx => applyKnowledgeLifecycle(tx, {
    characterId, itemId, operation: "RESTORE", expectedRevision,
  }));
  return { item, message: KNOWLEDGE_LIFECYCLE_RULES.RESTORE.message };
});
