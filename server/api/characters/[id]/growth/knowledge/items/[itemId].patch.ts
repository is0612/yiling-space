import { createError, getRouterParam, readBody } from "h3";
import type { Prisma } from "../../../../../../../src/generated/prisma/client";
import { requireActorUserId } from "../../../../../../utils/auth";
import { requireUuid } from "../../../../../../utils/local-api";
import { getPrisma } from "../../../../../../utils/prisma";
import { knowledgeItemPatchChanges, parseKnowledgeItemPatch } from "../../../../../../utils/knowledge-item-versioning";

export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const itemId = requireUuid(getRouterParam(event, "itemId") ?? "", "正式知识");
  const prisma = getPrisma();
  const character = await prisma.character.findFirst({ where: { id: characterId, ownerId }, select: { id: true } });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });

  let parsed: ReturnType<typeof parseKnowledgeItemPatch>;
  try {
    parsed = parseKnowledgeItemPatch(await readBody(event));
  } catch (error) {
    throw createError({
      statusCode: 400,
      statusMessage: error instanceof Error ? error.message : "知识修改内容无效。",
    });
  }

  return prisma.$transaction(async (tx) => {
    const current = await tx.knowledgeItem.findFirst({
      where: { id: itemId, characterId, status: "ACTIVE" },
    });
    if (!current) throw createError({ statusCode: 404, statusMessage: "正式知识不存在或已归档。" });
    if (current.revision !== parsed.expectedRevision) {
      throw createError({ statusCode: 409, statusMessage: "这条知识已被其他操作修改，请刷新后再编辑。" });
    }
    if (!knowledgeItemPatchChanges(current, parsed.patch)) {
      return { item: current, unchanged: true };
    }

    const updated = await tx.knowledgeItem.updateMany({
      where: { id: itemId, characterId, status: "ACTIVE", revision: parsed.expectedRevision },
      data: { ...parsed.patch, revision: { increment: 1 } },
    });
    if (updated.count !== 1) {
      throw createError({ statusCode: 409, statusMessage: "这条知识刚刚发生变化，请刷新后再编辑。" });
    }

    await tx.knowledgeItemRevision.create({
      data: {
        itemId,
        revision: current.revision,
        title: current.title,
        content: current.content,
        category: current.category,
        tags: current.tags,
        confidence: current.confidence,
        status: current.status,
        sourceType: current.sourceType,
        sourceRef: current.sourceRef === null ? undefined : current.sourceRef as Prisma.InputJsonValue,
      },
    });

    const item = await tx.knowledgeItem.findFirstOrThrow({ where: { id: itemId, characterId } });
    return { item, unchanged: false };
  });
});
