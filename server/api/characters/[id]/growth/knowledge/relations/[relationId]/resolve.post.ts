import { createError, defineEventHandler, getRouterParam, readBody } from "h3";
import type { Prisma } from "../../../../../../../src/generated/prisma/client";
import { requireActorUserId } from "../../../../../../../utils/auth";
import { requireUuid } from "../../../../../../../utils/local-api";
import { getPrisma } from "../../../../../../../utils/prisma";
import { parseKnowledgeRelationDecision } from "../../../../../../../utils/knowledge-item-governance";

export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const relationId = requireUuid(getRouterParam(event, "relationId") ?? "", "知识关联");
  const prisma = getPrisma();
  const character = await prisma.character.findFirst({ where: { id: characterId, ownerId }, select: { id: true } });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });

  let input: ReturnType<typeof parseKnowledgeRelationDecision>;
  try {
    input = parseKnowledgeRelationDecision(await readBody(event));
  } catch (error) {
    throw createError({ statusCode: 400, statusMessage: error instanceof Error ? error.message : "处置内容无效。" });
  }

  return prisma.$transaction(async (tx) => {
    const relation = await tx.knowledgeItemRelation.findFirst({
      where: { id: relationId, characterId, relationType: { in: ["DUPLICATE", "CONFLICT"] } },
      include: {
        sourceItem: { select: { id: true, revision: true, status: true } },
        targetItem: { select: { id: true, revision: true, status: true } },
      },
    });
    if (!relation) throw createError({ statusCode: 404, statusMessage: "知识关联不存在。" });
    if (relation.status !== "OPEN") throw createError({ statusCode: 409, statusMessage: "这条关联已经处置，请刷新后查看。" });
    if (relation.sourceItem.revision !== input.expectedSourceRevision
      || relation.targetItem.revision !== input.expectedTargetRevision) {
      throw createError({ statusCode: 409, statusMessage: "关联知识已发生变化，请刷新后重新判断。" });
    }
    if (relation.sourceItem.status !== "ACTIVE" || relation.targetItem.status !== "ACTIVE") {
      throw createError({ statusCode: 409, statusMessage: "关联知识已不再同时处于有效状态，请刷新后查看。" });
    }

    const isConflict = relation.relationType === "CONFLICT";
    const allowed = isConflict
      ? ["CONFIRM_CONFLICT", "NEEDS_VERIFICATION", "DISMISS"]
      : ["KEEP_SEPARATE", "DISMISS"];
    if (!allowed.includes(input.action)) {
      throw createError({ statusCode: 400, statusMessage: "该关系类型不支持此处置方式。" });
    }
    const status = input.action === "DISMISS" ? "DISMISSED"
      : input.action === "NEEDS_VERIFICATION" ? "OPEN" : "RESOLVED";
    const resolution = input.action;
    const updated = await tx.knowledgeItemRelation.updateMany({
      where: { id: relation.id, characterId, status: "OPEN" },
      data: {
        status, resolution,
        resolvedAt: status === "OPEN" ? null : new Date(),
        metadata: {
          ...(relation.metadata && typeof relation.metadata === "object" && !Array.isArray(relation.metadata)
            ? relation.metadata as Prisma.JsonObject : {}),
          decisionSource: "USER",
          sourceRevision: relation.sourceItem.revision,
          targetRevision: relation.targetItem.revision,
        } as Prisma.InputJsonValue,
      },
    });
    if (updated.count !== 1) {
      throw createError({ statusCode: 409, statusMessage: "这条关联刚刚被其他操作处置，请刷新后重试。" });
    }
    return { relation: await tx.knowledgeItemRelation.findUniqueOrThrow({ where: { id: relation.id } }) };
  });
});
