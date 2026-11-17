import { randomUUID } from "node:crypto";
import { createError } from "h3";
import { Prisma, type PrismaClient } from "../../src/generated/prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;
type SnapshotMember = { itemId: string; itemRevision: number };
type Snapshot = {
  id: string; topicId: string; revision: number; name: string; description: string;
  status: "ACTIVE" | "ARCHIVED" | "MERGED"; mergedIntoId: string | null;
  members: unknown; action: string; operationId: string | null; relatedTopicId: string | null;
};

function fail(statusCode: number, statusMessage: string): never {
  throw createError({ statusCode, statusMessage });
}
function parseMembers(value: unknown): SnapshotMember[] {
  if (!Array.isArray(value) || value.some(member => !member || typeof member !== "object"
    || typeof (member as Record<string, unknown>).itemId !== "string"
    || !Number.isInteger((member as Record<string, unknown>).itemRevision))) {
    fail(409, "历史快照格式无效，无法安全恢复。");
  }
  return value as SnapshotMember[];
}
async function lockTopics(tx: Db, characterId: string, ids: string[]) {
  const uniqueIds = [...new Set(ids)].sort();
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "knowledge_topics"
    WHERE "id" = ANY(${uniqueIds}::uuid[]) AND "characterId" = ${characterId}::uuid
    ORDER BY "id" FOR UPDATE
  `;
  if (rows.length !== uniqueIds.length) fail(404, "主题不存在或不属于当前角色。");
  return tx.knowledgeTopic.findMany({
    where: { id: { in: uniqueIds }, characterId },
    include: { members: { orderBy: { itemId: "asc" }, select: { itemId: true, itemRevision: true } } },
  });
}
async function saveCurrent(tx: Db, topic: {
  id: string; revision: number; name: string; description: string;
  status: "ACTIVE" | "ARCHIVED" | "MERGED"; mergedIntoId: string | null;
  members: SnapshotMember[];
}, operationId: string, relatedTopicId: string | null) {
  await tx.knowledgeTopicRevision.create({
    data: {
      topicId: topic.id, revision: topic.revision, name: topic.name,
      description: topic.description, status: topic.status, mergedIntoId: topic.mergedIntoId,
      members: topic.members as unknown as Prisma.InputJsonValue,
      action: "RESTORE", operationId, relatedTopicId,
    },
  });
}

export async function listKnowledgeTopicRevisions(
  prisma: PrismaClient, characterId: string, topicId: string,
) {
  const topic = await prisma.knowledgeTopic.findFirst({
    where: { id: topicId, characterId }, select: { id: true, revision: true },
  });
  if (!topic) fail(404, "主题不存在。");
  const revisions = await prisma.knowledgeTopicRevision.findMany({
    where: { topicId },
    orderBy: [{ revision: "desc" }],
    take: 50,
    select: {
      id: true, revision: true, name: true, description: true, status: true,
      mergedIntoId: true, members: true, action: true, operationId: true,
      relatedTopicId: true, createdAt: true,
    },
  });
  return {
    topicId, currentRevision: topic.revision,
    revisions: revisions.map(revision => ({
      ...revision,
      memberCount: Array.isArray(revision.members) ? revision.members.length : 0,
    })),
  };
}

export async function restoreKnowledgeTopicRevision(
  prisma: PrismaClient,
  characterId: string,
  topicId: string,
  input: { revisionId?: unknown; expectedRevision?: unknown },
) {
  if (typeof input.revisionId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.revisionId)) {
    fail(400, "请提供有效的历史版本 ID。");
  }
  if (!Number.isInteger(input.expectedRevision) || (input.expectedRevision as number) < 1) {
    fail(400, "请提供当前主题版本号。");
  }

  const selected = await prisma.knowledgeTopicRevision.findFirst({
    where: { id: input.revisionId, topicId },
  }) as Snapshot | null;
  if (!selected) fail(404, "历史版本不存在。");
  const snapshots = (selected.operationId
    ? await prisma.knowledgeTopicRevision.findMany({ where: { operationId: selected.operationId }, orderBy: { topicId: "asc" } })
    : [selected]) as Snapshot[];
  if (selected.action === "SPLIT" && !selected.relatedTopicId) {
    fail(409, "该拆分历史缺少关联主题信息，不能执行原子撤销。");
  }
  if (selected.action === "MERGE" && snapshots.length !== 2) {
    fail(409, "合并历史不完整，不能执行原子撤销。");
  }
  const topicIds = [
    ...snapshots.map(snapshot => snapshot.topicId),
    ...(selected.action === "SPLIT" && selected.relatedTopicId ? [selected.relatedTopicId] : []),
  ];

  return prisma.$transaction(async tx => {
    const topics = await lockTopics(tx, characterId, topicIds);
    const byId = new Map(topics.map(topic => [topic.id, topic]));
    const primary = byId.get(topicId);
    if (!primary) fail(404, "主题不存在。");
    if (primary.revision !== input.expectedRevision) fail(409, "主题已发生变化，请刷新历史后重试。");

    for (const snapshot of snapshots) {
      const current = byId.get(snapshot.topicId);
      if (!current || current.revision !== snapshot.revision + 1) {
        fail(409, "关联主题在该操作后又发生了变化，无法安全撤销整笔操作。");
      }
    }
    if (selected.action === "SPLIT") {
      const created = byId.get(selected.relatedTopicId!);
      if (!created || created.revision !== 1 || created.status !== "ACTIVE") {
        fail(409, "拆分后创建的主题已发生变化，无法安全撤销整笔操作。");
      }
    }

    const parsed = new Map(snapshots.map(snapshot => [snapshot.topicId, parseMembers(snapshot.members)]));
    const itemIds = [...new Set([...parsed.values()].flat().map(member => member.itemId))];
    if (itemIds.length) {
      const existing = await tx.knowledgeItem.findMany({
        where: { id: { in: itemIds }, characterId },
        select: { id: true },
      });
      if (existing.length !== itemIds.length) fail(409, "历史快照引用的部分知识已不存在或不属于当前角色，无法恢复。");
    }

    const restoreOperationId = randomUUID();
    for (const snapshot of snapshots) {
      const current = byId.get(snapshot.topicId)!;
      await saveCurrent(tx, current, restoreOperationId, snapshot.topicId === topicId ? snapshot.relatedTopicId : topicId);
    }
    if (selected.action === "SPLIT") {
      const created = byId.get(selected.relatedTopicId!)!;
      await saveCurrent(tx, created, restoreOperationId, topicId);
    }

    for (const snapshot of snapshots) {
      const members = parsed.get(snapshot.topicId)!;
      await tx.knowledgeTopicMember.deleteMany({ where: { topicId: snapshot.topicId } });
      if (members.length) {
        await tx.knowledgeTopicMember.createMany({
          data: members.map(member => ({ topicId: snapshot.topicId, ...member })),
        });
      }
      await tx.knowledgeTopic.update({
        where: { id: snapshot.topicId },
        data: {
          name: snapshot.name, description: snapshot.description,
          status: snapshot.status, mergedIntoId: snapshot.mergedIntoId,
          mergedAt: snapshot.status === "MERGED" ? byId.get(snapshot.topicId)!.mergedAt : null,
          revision: { increment: 1 },
        },
      });
    }
    if (selected.action === "SPLIT") {
      const createdId = selected.relatedTopicId!;
      await tx.knowledgeTopicMember.deleteMany({ where: { topicId: createdId } });
      await tx.knowledgeTopic.update({
        where: { id: createdId },
        data: { status: "ARCHIVED", revision: { increment: 1 } },
      });
    }
    const restored = await tx.knowledgeTopic.findUniqueOrThrow({
      where: { id: topicId },
      select: { id: true, name: true, description: true, status: true, revision: true, mergedIntoId: true },
    });
    return {
      topic: restored,
      restoredRevision: selected.revision,
      action: selected.action,
      affectedTopicIds: topicIds,
      message: selected.action === "SPLIT" || selected.action === "MERGE"
        ? "已原子撤销关联主题操作，并保留全部历史记录。"
        : "已将主题恢复到所选历史版本；恢复操作作为新的版本保留。",
    };
  }, { timeout: 20_000 });
}
