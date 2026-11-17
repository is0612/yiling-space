import { createError } from "h3";
import { Prisma, type PrismaClient } from "../../src/generated/prisma/client";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Db = PrismaClient | Prisma.TransactionClient;
type Topic = {
  id: string;
  name: string;
  description: string;
  status: "ACTIVE" | "ARCHIVED" | "MERGED";
  revision: number;
  mergedIntoId: string | null;
  members: Array<{ itemId: string; itemRevision: number }>;
};

function fail(statusCode: number, statusMessage: string): never {
  throw createError({ statusCode, statusMessage });
}

function parseTopicName(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 200) {
    fail(400, "新主题名称不能为空，且不能超过 200 个字符。");
  }
  return value.trim();
}

function parseDescription(value: unknown): string {
  if (value !== undefined && (typeof value !== "string" || value.length > 5_000)) {
    fail(400, "主题说明必须是文本，且不能超过 5000 个字符。");
  }
  return typeof value === "string" ? value.trim() : "";
}

function requireRevision(value: unknown, current: number, field: string) {
  if (!Number.isInteger(value) || value !== current) {
    fail(409, `${field}已变化，请刷新后重试。`);
  }
}

async function lockTopics(tx: Db, characterId: string, topicIds: string[]) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "knowledge_topics"
    WHERE "id" = ANY(${topicIds}::uuid[]) AND "characterId" = ${characterId}::uuid
    ORDER BY "id" FOR UPDATE
  `;
  if (rows.length !== topicIds.length) fail(404, "主题不存在。");
  const topics = await tx.knowledgeTopic.findMany({
    where: { id: { in: topicIds }, characterId },
    include: { members: { orderBy: { itemId: "asc" }, select: { itemId: true, itemRevision: true } } },
  });
  return new Map(topics.map(topic => [topic.id, topic]));
}

async function saveTopicRevision(tx: Db, topic: Topic) {
  await tx.knowledgeTopicRevision.create({
    data: {
      topicId: topic.id,
      revision: topic.revision,
      name: topic.name,
      description: topic.description,
      status: topic.status,
      mergedIntoId: topic.mergedIntoId,
      members: topic.members.map(member => ({
        itemId: member.itemId,
        itemRevision: member.itemRevision,
      })) as unknown as Prisma.InputJsonValue,
    },
  });
}

export async function splitKnowledgeTopic(
  prisma: PrismaClient,
  characterId: string,
  topicId: string,
  input: { name?: unknown; description?: unknown; memberItemIds?: unknown; revision?: unknown },
) {
  const name = parseTopicName(input.name);
  const description = parseDescription(input.description);
  if (!Array.isArray(input.memberItemIds) || input.memberItemIds.length < 1
    || input.memberItemIds.length > 50
    || input.memberItemIds.some(id => typeof id !== "string" || !UUID.test(id))) {
    fail(400, "请提供 1–50 个有效的主题成员 ID。");
  }
  const selectedIds = input.memberItemIds as string[];
  if (new Set(selectedIds).size !== selectedIds.length) fail(400, "拆分成员不能重复。");

  return prisma.$transaction(async tx => {
    const topics = await lockTopics(tx, characterId, [topicId]);
    const source = topics.get(topicId)!;
    if (source.status !== "ACTIVE") fail(409, "只有 ACTIVE 主题可以拆分。");
    requireRevision(input.revision, source.revision, "原主题版本");
    const sourceIds = new Set(source.members.map(member => member.itemId));
    if (selectedIds.some(id => !sourceIds.has(id)) || selectedIds.length >= source.members.length) {
      fail(400, "拆分成员必须是原主题成员的非空真子集，并至少为原主题保留一条知识。");
    }

    const selected = new Set(selectedIds);
    const movedMembers = source.members.filter(member => selected.has(member.itemId));
    const remainingMembers = source.members.filter(member => !selected.has(member.itemId));
    await saveTopicRevision(tx, source);
    const updatedSource = await tx.knowledgeTopic.update({
      where: { id: topicId },
      data: {
        revision: { increment: 1 },
        members: { deleteMany: { itemId: { in: selectedIds } } },
      },
      select: { id: true, name: true, description: true, status: true, revision: true, updatedAt: true },
    });
    const created = await tx.knowledgeTopic.create({
      data: {
        characterId,
        name,
        description,
        members: { create: movedMembers.map(member => ({
          itemId: member.itemId,
          itemRevision: member.itemRevision,
        })) },
      },
      select: { id: true, name: true, description: true, status: true, revision: true, createdAt: true, updatedAt: true },
    });
    return {
      sourceTopic: updatedSource,
      newTopic: created,
      movedItemIds: movedMembers.map(member => member.itemId),
      remainingItemIds: remainingMembers.map(member => member.itemId),
    };
  }, { timeout: 15_000 });
}

export async function mergeKnowledgeTopics(
  prisma: PrismaClient,
  characterId: string,
  sourceTopicId: string,
  input: { targetTopicId?: unknown; sourceRevision?: unknown; targetRevision?: unknown },
) {
  if (typeof input.targetTopicId !== "string" || !UUID.test(input.targetTopicId)) {
    fail(400, "请选择有效的目标主题。");
  }
  const targetTopicId = input.targetTopicId;
  if (sourceTopicId === targetTopicId) fail(400, "不能将主题合并到自身。");

  return prisma.$transaction(async tx => {
    const topics = await lockTopics(tx, characterId, [sourceTopicId, targetTopicId]);
    const source = topics.get(sourceTopicId)!;
    const target = topics.get(targetTopicId)!;
    if (source.status !== "ACTIVE" || target.status !== "ACTIVE") {
      fail(409, "只有两个 ACTIVE 主题之间可以执行合并。");
    }
    requireRevision(input.sourceRevision, source.revision, "来源主题版本");
    requireRevision(input.targetRevision, target.revision, "目标主题版本");

    const targetIds = new Set(target.members.map(member => member.itemId));
    const additions = source.members.filter(member => !targetIds.has(member.itemId));
    const now = new Date();

    await saveTopicRevision(tx, source);
    await tx.knowledgeTopic.update({
      where: { id: sourceTopicId },
      data: {
        status: "MERGED",
        mergedIntoId: targetTopicId,
        mergedAt: now,
        revision: { increment: 1 },
      },
    });

    if (additions.length) {
      await saveTopicRevision(tx, target);
      await tx.knowledgeTopicMember.createMany({
        data: additions.map(member => ({
          topicId: targetTopicId,
          itemId: member.itemId,
          itemRevision: member.itemRevision,
        })),
      });
      await tx.knowledgeTopic.update({
        where: { id: targetTopicId },
        data: { revision: { increment: 1 } },
      });
    }

    const [updatedSource, updatedTarget] = await Promise.all([
      tx.knowledgeTopic.findUniqueOrThrow({
        where: { id: sourceTopicId },
        select: { id: true, name: true, status: true, revision: true, mergedIntoId: true, mergedAt: true },
      }),
      tx.knowledgeTopic.findUniqueOrThrow({
        where: { id: targetTopicId },
        include: { members: { orderBy: { itemId: "asc" }, select: { itemId: true, itemRevision: true } } },
      }),
    ]);
    return {
      sourceTopic: updatedSource,
      targetTopic: {
        id: updatedTarget.id,
        name: updatedTarget.name,
        status: updatedTarget.status,
        revision: updatedTarget.revision,
        members: updatedTarget.members,
      },
      addedItemIds: additions.map(member => member.itemId),
      alreadyPresentItemIds: source.members.filter(member => targetIds.has(member.itemId)).map(member => member.itemId),
    };
  }, { timeout: 15_000 });
}
