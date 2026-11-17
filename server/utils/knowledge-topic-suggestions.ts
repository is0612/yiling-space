import { createError } from "h3";
import { Prisma, type PrismaClient } from "../../src/generated/prisma/client";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type AcceptInput = { mode?: unknown; topicId?: unknown; memberItemIds?: unknown };

function fail(statusCode: number, statusMessage: string): never {
  throw createError({ statusCode, statusMessage });
}

function idsFromJson(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(id => typeof id !== "string" || !UUID.test(id))) {
    fail(409, "主题建议数据无效，请重新发现主题。");
  }
  return value as string[];
}

export async function acceptKnowledgeTopicSuggestion(
  prisma: PrismaClient,
  characterId: string,
  suggestionId: string,
  input: AcceptInput,
) {
  if (input.mode !== "CREATE" && input.mode !== "APPLY") {
    fail(400, "采纳模式必须是 CREATE 或 APPLY。");
  }
  if (input.mode === "APPLY" && (typeof input.topicId !== "string" || !UUID.test(input.topicId))) {
    fail(400, "请选择要应用到的有效主题。");
  }
  if (input.mode === "CREATE" && input.topicId !== undefined) {
    fail(400, "创建新主题时不能传入 topicId。");
  }

  return prisma.$transaction(async tx => {
    const locked = await tx.$queryRaw<Array<{
      id: string; runId: string; status: string; name: string; description: string;
      memberItemIds: unknown; runStatus: string; inputSnapshot: unknown;
    }>>`
      SELECT suggestion."id", suggestion."runId", suggestion."status", suggestion."name",
        suggestion."description", suggestion."memberItemIds", run."status" AS "runStatus",
        run."inputSnapshot"
      FROM "knowledge_topic_suggestions" AS suggestion
      JOIN "knowledge_topic_runs" AS run ON run."id" = suggestion."runId"
      WHERE suggestion."id" = ${suggestionId}::uuid AND run."characterId" = ${characterId}::uuid
      FOR UPDATE OF run, suggestion
    `;
    const suggestion = locked[0];
    if (!suggestion) fail(404, "主题建议不存在。");
    if (suggestion.runStatus !== "READY") fail(409, "主题发现批次已失效，不能采纳。");
    if (suggestion.status !== "PENDING") fail(409, "该建议已处理，不能重复采纳或忽略。");

    const suggestedIds = idsFromJson(suggestion.memberItemIds);
    if (suggestedIds.length < 2 || new Set(suggestedIds).size !== suggestedIds.length) {
      fail(409, "主题建议成员无效，请重新发现主题。");
    }
    const selectedIds = input.memberItemIds === undefined
      ? suggestedIds
      : idsFromJson(input.memberItemIds);
    if (selectedIds.length < 1 || new Set(selectedIds).size !== selectedIds.length
      || selectedIds.some(id => !suggestedIds.includes(id))) {
      fail(400, "实际采纳成员必须是建议成员的非空子集，且不能重复。");
    }

    const snapshot = suggestion.inputSnapshot;
    if (!Array.isArray(snapshot)) fail(409, "主题发现批次快照无效。");
    const revisionById = new Map<string, number>();
    for (const row of snapshot) {
      if (!row || typeof row !== "object" || typeof (row as { itemId?: unknown }).itemId !== "string"
        || !Number.isInteger((row as { revision?: unknown }).revision)) {
        fail(409, "主题发现批次快照无效。");
      }
      const itemId = (row as { itemId: string }).itemId;
      const revision = (row as { revision: number }).revision;
      if (!UUID.test(itemId) || revision < 1) fail(409, "主题发现批次快照无效。");
      revisionById.set(itemId, revision);
    }
    if (suggestedIds.some(id => !revisionById.has(id))) {
      fail(409, "主题建议成员不在本次发现批次中。");
    }

    const items = await tx.$queryRaw<Array<{ id: string; revision: number }>>`
      SELECT "id", "revision" FROM "knowledge_items"
      WHERE "characterId" = ${characterId}::uuid AND "status" = 'ACTIVE'
        AND "id" = ANY(${selectedIds}::uuid[])
      ORDER BY "id" FOR SHARE
    `;
    if (items.length !== selectedIds.length
      || items.some(item => revisionById.get(item.id) !== item.revision)) {
      fail(409, "建议中的知识已变化或不再有效，请重新发现主题。");
    }

    let topic: { id: string; name: string; description: string; revision: number };
    if (input.mode === "CREATE") {
      topic = await tx.knowledgeTopic.create({
        data: {
          characterId,
          name: suggestion.name,
          description: suggestion.description,
          members: { create: selectedIds.map(itemId => ({
            itemId, itemRevision: revisionById.get(itemId)!,
          })) },
        },
        select: { id: true, name: true, description: true, revision: true },
      });
    } else {
      const topicId = input.topicId as string;
      const targetRows = await tx.$queryRaw<Array<{ id: string; revision: number }>>`
        SELECT "id", "revision" FROM "knowledge_topics"
        WHERE "id" = ${topicId}::uuid AND "characterId" = ${characterId}::uuid AND "status" = 'ACTIVE'
        FOR UPDATE
      `;
      if (!targetRows.length) fail(404, "目标主题不存在或不可编辑。");
      const target = await tx.knowledgeTopic.findUniqueOrThrow({
        where: { id: topicId },
        select: { id: true, name: true, description: true, revision: true },
      });
      const currentMembers = await tx.knowledgeTopicMember.findMany({
        where: { topicId },
        orderBy: { itemId: "asc" },
        select: { itemId: true, itemRevision: true },
      });
      const currentIds = new Set(currentMembers.map(member => member.itemId));
      const additions = selectedIds.filter(id => !currentIds.has(id));
      if (additions.length) {
        await tx.knowledgeTopicRevision.create({
          data: {
            topicId,
            revision: target.revision,
            name: target.name,
            description: target.description,
            status: "ACTIVE",
            members: currentMembers as unknown as Prisma.InputJsonValue,
          },
        });
        await tx.knowledgeTopic.update({
          where: { id: topicId },
          data: { revision: { increment: 1 } },
        });
        await tx.knowledgeTopicMember.createMany({
          data: additions.map(itemId => ({ topicId, itemId, itemRevision: revisionById.get(itemId)! })),
        });
      }
      topic = { ...target, revision: target.revision + (additions.length ? 1 : 0) };
    }

    await tx.knowledgeTopicSuggestion.update({
      where: { id: suggestionId },
      data: {
        status: "ACCEPTED",
        acceptedMemberItemIds: selectedIds as unknown as Prisma.InputJsonValue,
        reviewedAt: new Date(),
      },
    });
    return { topic, acceptedMemberItemIds: selectedIds };
  }, { timeout: 15_000 });
}

export async function dismissKnowledgeTopicSuggestion(
  prisma: PrismaClient,
  characterId: string,
  suggestionId: string,
) {
  return prisma.$transaction(async tx => {
    const rows = await tx.$queryRaw<Array<{ id: string; status: string; runStatus: string }>>`
      SELECT suggestion."id", suggestion."status", run."status" AS "runStatus"
      FROM "knowledge_topic_suggestions" AS suggestion
      JOIN "knowledge_topic_runs" AS run ON run."id" = suggestion."runId"
      WHERE suggestion."id" = ${suggestionId}::uuid AND run."characterId" = ${characterId}::uuid
      FOR UPDATE OF run, suggestion
    `;
    const suggestion = rows[0];
    if (!suggestion) fail(404, "主题建议不存在。");
    if (suggestion.runStatus !== "READY") fail(409, "主题发现批次已失效，不能忽略建议。");
    if (suggestion.status !== "PENDING") fail(409, "该建议已处理，不能重复采纳或忽略。");
    await tx.knowledgeTopicSuggestion.update({
      where: { id: suggestionId },
      data: { status: "DISMISSED", reviewedAt: new Date() },
    });
    return { id: suggestionId, status: "DISMISSED" as const };
  }, { timeout: 10_000 });
}
