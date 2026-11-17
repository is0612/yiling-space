import { createError } from "h3";
import { Prisma, type PrismaClient } from "../../src/generated/prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;
type SnapshotMember = { itemId: string; itemRevision: number };

function fail(statusCode: number, statusMessage: string): never {
  throw createError({ statusCode, statusMessage });
}

function parseRevision(value: unknown): number {
  const revision = typeof value === "string" ? Number(value) : value;
  if (!Number.isSafeInteger(revision) || Number(revision) < 1) fail(400, "无效的主题版本号。");
  return Number(revision);
}

function parseMembers(value: Prisma.JsonValue): SnapshotMember[] {
  if (!Array.isArray(value)) fail(409, "历史快照成员数据无效，无法恢复。");
  const members: SnapshotMember[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail(409, "历史快照成员数据无效，无法恢复。");
    const row = entry as Record<string, unknown>;
    if (typeof row.itemId !== "string" || !Number.isSafeInteger(row.itemRevision) || Number(row.itemRevision) < 1
      || seen.has(row.itemId)) fail(409, "历史快照成员数据无效，无法恢复。");
    seen.add(row.itemId);
    members.push({ itemId: row.itemId, itemRevision: Number(row.itemRevision) });
  }
  return members;
}

export async function listKnowledgeTopicRevisions(
  prisma: PrismaClient, characterId: string, topicId: string, limit = 50,
) {
  const topic = await prisma.knowledgeTopic.findFirst({
    where: { id: topicId, characterId }, select: { id: true, revision: true },
  });
  if (!topic) fail(404, "主题不存在。");
  const revisions = await prisma.knowledgeTopicRevision.findMany({
    where: { topicId }, orderBy: { revision: "desc" }, take: Math.min(Math.max(limit, 1), 100),
    select: {
      id: true, revision: true, name: true, description: true, status: true,
      mergedIntoId: true, createdAt: true,
    },
  });
  return { topicId, currentRevision: topic.revision, revisions };
}

export async function getKnowledgeTopicRevision(
  prisma: PrismaClient, characterId: string, topicId: string, revisionValue: unknown,
) {
  const revision = parseRevision(revisionValue);
  const topic = await prisma.knowledgeTopic.findFirst({
    where: { id: topicId, characterId }, select: { id: true, revision: true },
  });
  if (!topic) fail(404, "主题不存在。");
  const snapshot = await prisma.knowledgeTopicRevision.findFirst({
    where: { topicId, revision },
    select: {
      id: true, revision: true, name: true, description: true, status: true,
      mergedIntoId: true, members: true, createdAt: true,
    },
  });
  if (!snapshot) fail(404, "主题历史版本不存在。");
  return { topicId, currentRevision: topic.revision, snapshot };
}

export async function restoreKnowledgeTopicRevision(
  prisma: PrismaClient, characterId: string, topicId: string,
  revisionValue: unknown, expectedRevisionValue: unknown,
) {
  const revision = parseRevision(revisionValue);
  const expectedRevision = parseRevision(expectedRevisionValue);
  return prisma.$transaction(async tx => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "knowledge_topics"
      WHERE "id" = ${topicId}::uuid AND "characterId" = ${characterId}::uuid
      FOR UPDATE
    `;
    if (!locked.length) fail(404, "主题不存在。");
    const topic = await tx.knowledgeTopic.findUniqueOrThrow({
      where: { id: topicId },
      include: { members: { orderBy: { itemId: "asc" }, select: { itemId: true, itemRevision: true } } },
    });
    if (topic.status === "MERGED") fail(409, "已合并主题不可撤销或恢复。");
    if (topic.revision !== expectedRevision) fail(409, "主题已被其他操作更新，请刷新后重试。");
    if (revision >= topic.revision) fail(400, "只能恢复到当前版本之前的历史版本。");
    const snapshot = await tx.knowledgeTopicRevision.findFirst({ where: { topicId, revision } });
    if (!snapshot) fail(404, "主题历史版本不存在。");
    if (snapshot.status === "MERGED" || snapshot.mergedIntoId) fail(409, "不能恢复到已合并状态。");
    if (snapshot.status !== "ACTIVE" && snapshot.status !== "ARCHIVED") fail(409, "历史版本状态不支持恢复。");
    const members = parseMembers(snapshot.members);
    if (members.length) {
      const validItems = await tx.knowledgeItem.findMany({
        where: { characterId, status: "ACTIVE", id: { in: members.map(member => member.itemId) } },
        select: { id: true },
      });
      if (validItems.length !== members.length) {
        fail(409, "历史版本包含已删除、归档或不属于当前角色的知识，无法完整恢复。");
      }
    }

    await tx.knowledgeTopicRevision.create({
      data: {
        topicId, revision: topic.revision, name: topic.name, description: topic.description,
        status: topic.status, mergedIntoId: topic.mergedIntoId,
        members: topic.members.map(member => ({ itemId: member.itemId, itemRevision: member.itemRevision })) as unknown as Prisma.InputJsonValue,
      },
    });
    await tx.knowledgeTopicMember.deleteMany({ where: { topicId } });
    if (members.length) {
      await tx.knowledgeTopicMember.createMany({
        data: members.map(member => ({ topicId, itemId: member.itemId, itemRevision: member.itemRevision })),
      });
    }
    const restored = await tx.knowledgeTopic.update({
      where: { id: topicId },
      data: {
        name: snapshot.name, description: snapshot.description, status: snapshot.status,
        mergedIntoId: null, mergedAt: null, revision: { increment: 1 },
      },
      include: { members: { orderBy: { itemId: "asc" }, select: { itemId: true, itemRevision: true } } },
    });
    return {
      topic: {
        id: restored.id, name: restored.name, description: restored.description,
        status: restored.status, revision: restored.revision, members: restored.members,
      },
      restoredFromRevision: revision,
    };
  }, { timeout: 15_000 });
}
