import { createError } from "h3";
import { Prisma, type PrismaClient } from "../../src/generated/prisma/client";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Db = PrismaClient | Prisma.TransactionClient;
type TopicInput = { name?: unknown; description?: unknown; status?: unknown; revision?: unknown };

function fail(statusCode: number, statusMessage: string): never {
  throw createError({ statusCode, statusMessage });
}
function parseName(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 200) {
    fail(400, "主题名称不能为空，且不能超过 200 个字符。");
  }
  return value.trim();
}
function parseDescription(value: unknown): string {
  if (typeof value !== "string" || value.length > 5_000) {
    fail(400, "主题说明必须是文本，且不能超过 5000 个字符。");
  }
  return value.trim();
}
function checkRevision(value: unknown, current: number) {
  if (value !== undefined && (!Number.isInteger(value) || value !== current)) {
    fail(409, "主题已被其他操作更新，请刷新后重试。");
  }
}
async function lockTopic(tx: Db, characterId: string, topicId: string, editable = true) {
  const rows = await tx.$queryRaw<Array<{ id: string; revision: number }>>`
    SELECT "id", "revision" FROM "knowledge_topics"
    WHERE "id" = ${topicId}::uuid AND "characterId" = ${characterId}::uuid
    FOR UPDATE
  `;
  if (!rows.length) fail(404, "主题不存在。");
  const topic = await tx.knowledgeTopic.findUniqueOrThrow({
    where: { id: topicId },
    include: { members: { orderBy: { itemId: "asc" }, select: { itemId: true, itemRevision: true } } },
  });
  if (editable && topic.status === "MERGED") fail(409, "已合并主题不可直接编辑。");
  return topic;
}
async function saveRevision(tx: Db, topic: Awaited<ReturnType<typeof lockTopic>>) {
  await tx.knowledgeTopicRevision.create({
    data: {
      topicId: topic.id, revision: topic.revision, name: topic.name,
      description: topic.description, status: topic.status, mergedIntoId: topic.mergedIntoId,
      members: topic.members.map(member => ({ itemId: member.itemId, itemRevision: member.itemRevision })) as unknown as Prisma.InputJsonValue,
    },
  });
}

export async function createKnowledgeTopic(prisma: PrismaClient, characterId: string, input: TopicInput) {
  const name = parseName(input.name);
  const description = input.description === undefined ? "" : parseDescription(input.description);
  return prisma.knowledgeTopic.create({
    data: { characterId, name, description },
    select: { id: true, name: true, description: true, status: true, revision: true, createdAt: true, updatedAt: true },
  });
}

export async function updateKnowledgeTopic(prisma: PrismaClient, characterId: string, topicId: string, input: TopicInput) {
  if (input.name === undefined && input.description === undefined && input.status === undefined) {
    fail(400, "至少提供一个需要修改的字段。");
  }
  const name = input.name === undefined ? undefined : parseName(input.name);
  const description = input.description === undefined ? undefined : parseDescription(input.description);
  if (input.status !== undefined && input.status !== "ACTIVE" && input.status !== "ARCHIVED") {
    fail(400, "主题状态只能设置为 ACTIVE 或 ARCHIVED。");
  }
  const status: "ACTIVE" | "ARCHIVED" | undefined =
    input.status === "ACTIVE" || input.status === "ARCHIVED" ? input.status : undefined;
  return prisma.$transaction(async tx => {
    const topic = await lockTopic(tx, characterId, topicId);
    checkRevision(input.revision, topic.revision);
    const changed = (name !== undefined && name !== topic.name)
      || (description !== undefined && description !== topic.description)
      || (status !== undefined && status !== topic.status);
    if (!changed) return { id: topic.id, name: topic.name, description: topic.description, status: topic.status, revision: topic.revision };
    await saveRevision(tx, topic);
    const updated = await tx.knowledgeTopic.update({
      where: { id: topicId },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(status !== undefined ? { status } : {}),
        revision: { increment: 1 },
      },
      select: { id: true, name: true, description: true, status: true, revision: true, updatedAt: true },
    });
    return updated;
  }, { timeout: 15_000 });
}

export async function addKnowledgeTopicMembers(prisma: PrismaClient, characterId: string, topicId: string, input: { itemIds?: unknown; revision?: unknown }) {
  if (!Array.isArray(input.itemIds) || input.itemIds.length < 1 || input.itemIds.length > 50
    || input.itemIds.some(id => typeof id !== "string" || !UUID.test(id))) {
    fail(400, "请提供 1–50 个有效知识条目 ID。");
  }
  const itemIds = input.itemIds as string[];
  if (new Set(itemIds).size !== itemIds.length) fail(400, "知识条目不能重复。");
  return prisma.$transaction(async tx => {
    const topic = await lockTopic(tx, characterId, topicId);
    checkRevision(input.revision, topic.revision);
    if (topic.status !== "ACTIVE") fail(409, "只有 ACTIVE 主题可以添加知识成员。");
    const items = await tx.$queryRaw<Array<{ id: string; revision: number }>>`
      SELECT "id", "revision" FROM "knowledge_items"
      WHERE "characterId" = ${characterId}::uuid AND "status" = 'ACTIVE'
        AND "id" = ANY(${itemIds}::uuid[])
      ORDER BY "id" FOR SHARE
    `;
    if (items.length !== itemIds.length) fail(409, "部分知识不存在、不属于当前角色或已不是 ACTIVE 状态。");
    const existing = new Set(topic.members.map(member => member.itemId));
    const additions = itemIds.filter(id => !existing.has(id));
    if (!additions.length) return { topicId, addedItemIds: [], revision: topic.revision };
    await saveRevision(tx, topic);
    const revisionById = new Map(items.map(item => [item.id, item.revision]));
    await tx.knowledgeTopicMember.createMany({
      data: additions.map(itemId => ({ topicId, itemId, itemRevision: revisionById.get(itemId)! })),
    });
    const updated = await tx.knowledgeTopic.update({
      where: { id: topicId }, data: { revision: { increment: 1 } }, select: { revision: true },
    });
    return { topicId, addedItemIds: additions, revision: updated.revision };
  }, { timeout: 15_000 });
}

export async function removeKnowledgeTopicMember(prisma: PrismaClient, characterId: string, topicId: string, itemId: string, input: { revision?: unknown }) {
  return prisma.$transaction(async tx => {
    const topic = await lockTopic(tx, characterId, topicId);
    checkRevision(input.revision, topic.revision);
    if (topic.status !== "ACTIVE") fail(409, "只有 ACTIVE 主题可以移除知识成员。");
    if (!topic.members.some(member => member.itemId === itemId)) fail(404, "该知识不是此主题的成员。");
    await saveRevision(tx, topic);
    await tx.knowledgeTopicMember.delete({ where: { topicId_itemId: { topicId, itemId } } });
    const updated = await tx.knowledgeTopic.update({
      where: { id: topicId }, data: { revision: { increment: 1 } }, select: { revision: true },
    });
    return { topicId, removedItemId: itemId, revision: updated.revision };
  }, { timeout: 15_000 });
}
