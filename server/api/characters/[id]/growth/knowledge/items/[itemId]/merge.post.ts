import { createError, defineEventHandler, getRouterParam, readBody } from "h3";
import type { Prisma } from "../../../../../../../../src/generated/prisma/client";
import { requireActorUserId } from "../../../../../../../utils/auth";
import { requireUuid } from "../../../../../../../utils/local-api";
import { getPrisma } from "../../../../../../../utils/prisma";
import { parseKnowledgeMergeInput } from "../../../../../../../utils/knowledge-item-governance";

export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const sourceItemId = requireUuid(getRouterParam(event, "itemId") ?? "", "源知识");
  const prisma = getPrisma();
  const character = await prisma.character.findFirst({ where: { id: characterId, ownerId }, select: { id: true } });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });

  let input: ReturnType<typeof parseKnowledgeMergeInput>;
  try {
    input = parseKnowledgeMergeInput(await readBody(event));
    requireUuid(input.targetItemId, "目标知识");
  } catch (error) {
    throw createError({ statusCode: 400, statusMessage: error instanceof Error ? error.message : "合并内容无效。" });
  }
  if (sourceItemId === input.targetItemId) {
    throw createError({ statusCode: 400, statusMessage: "源知识和目标知识不能是同一条。" });
  }

  return prisma.$transaction(async (tx) => {
    const [source, target] = await Promise.all([
      tx.knowledgeItem.findFirst({ where: { id: sourceItemId, characterId, status: "ACTIVE" } }),
      tx.knowledgeItem.findFirst({ where: { id: input.targetItemId, characterId, status: "ACTIVE" } }),
    ]);
    if (!source || !target) {
      throw createError({ statusCode: 404, statusMessage: "源知识或目标知识不存在、已合并或不再处于有效状态。" });
    }
    if (source.revision !== input.expectedSourceRevision || target.revision !== input.expectedTargetRevision) {
      throw createError({ statusCode: 409, statusMessage: "知识内容已发生变化，请刷新双方内容后重新确认合并。" });
    }

    const duplicateLink = await tx.knowledgeItemRelation.findFirst({
      where: {
        characterId, relationType: "DUPLICATE", status: "OPEN",
        OR: [
          { sourceItemId: source.id, targetItemId: target.id },
          { sourceItemId: target.id, targetItemId: source.id },
        ],
      },
      select: { id: true },
    });
    if (!duplicateLink) {
      throw createError({ statusCode: 409, statusMessage: "这两条知识没有待处理的重复关系，请刷新后重新检查。" });
    }

    const sourceSnapshot = tx.knowledgeItemRevision.create({
      data: {
        itemId: source.id, revision: source.revision, title: source.title, content: source.content,
        category: source.category, tags: source.tags, confidence: source.confidence, status: source.status,
        sourceType: source.sourceType,
        action: "MERGE",
        sourceRef: source.sourceRef === null ? undefined : source.sourceRef as Prisma.InputJsonValue,
      },
    });
    const targetSnapshot = tx.knowledgeItemRevision.create({
      data: {
        itemId: target.id, revision: target.revision, title: target.title, content: target.content,
        category: target.category, tags: target.tags, confidence: target.confidence, status: target.status,
        sourceType: target.sourceType,
        action: "MERGE",
        sourceRef: target.sourceRef === null ? undefined : target.sourceRef as Prisma.InputJsonValue,
      },
    });
    const [sourceUpdate, targetUpdate] = await Promise.all([
      tx.knowledgeItem.updateMany({
        where: { id: source.id, characterId, status: "ACTIVE", revision: input.expectedSourceRevision },
        data: { status: "MERGED", revision: { increment: 1 } },
      }),
      tx.knowledgeItem.updateMany({
        where: { id: target.id, characterId, status: "ACTIVE", revision: input.expectedTargetRevision },
        data: {
          title: input.title, content: input.content, category: input.category,
          tags: input.tags, confidence: input.confidence, revision: { increment: 1 },
        },
      }),
    ]);
    if (sourceUpdate.count !== 1 || targetUpdate.count !== 1) {
      throw createError({ statusCode: 409, statusMessage: "合并过程中知识版本发生变化，未执行任何合并，请刷新后重试。" });
    }
    await Promise.all([sourceSnapshot, targetSnapshot]);

    const closedDuplicate = await tx.knowledgeItemRelation.updateMany({
      where: { id: duplicateLink.id, characterId, status: "OPEN" },
      data: { status: "RESOLVED", resolution: "MERGED", resolvedAt: new Date() },
    });
    if (closedDuplicate.count !== 1) {
      throw createError({ statusCode: 409, statusMessage: "重复关系刚刚发生变化，未执行合并，请刷新后重试。" });
    }
    // Once the source is merged, its other open suggestions can no longer be
    // acted on independently. Keep them for audit, but close them explicitly.
    await tx.knowledgeItemRelation.updateMany({
      where: {
        characterId, status: "OPEN",
        OR: [{ sourceItemId: source.id }, { targetItemId: source.id }],
      },
      data: { status: "DISMISSED", resolution: "SOURCE_MERGED", resolvedAt: new Date() },
    });
    const relation = await tx.knowledgeItemRelation.create({
      data: {
        characterId, sourceItemId: source.id, targetItemId: target.id,
        relationType: "MERGED_INTO", status: "RESOLVED", resolution: "MERGED", resolvedAt: new Date(),
        metadata: {
          sourceRevision: source.revision,
          targetRevision: target.revision,
          targetRevisionAfterMerge: target.revision + 1,
          confirmedBy: "USER",
        },
      },
    });
    const [mergedSource, mergedTarget] = await Promise.all([
      tx.knowledgeItem.findFirstOrThrow({ where: { id: source.id, characterId } }),
      tx.knowledgeItem.findFirstOrThrow({ where: { id: target.id, characterId } }),
    ]);
    return { source: mergedSource, target: mergedTarget, relation };
  });
});
