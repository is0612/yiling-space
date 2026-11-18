import { randomUUID } from "node:crypto";
import { createError } from "h3";
import { Prisma, type PrismaClient } from "../../src/generated/prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;
type SnapshotMember = { itemId: string; itemRevision: number };
type Snapshot = {
  id: string; topicId: string; revision: number; name: string; description: string;
  status: "ACTIVE" | "ARCHIVED" | "MERGED"; mergedIntoId: string | null;
  members: Prisma.JsonValue; action: string; operationId: string | null; relatedTopicId: string | null;
};

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
}, metadata: { action: string; operationId?: string | null; relatedTopicId?: string | null }) {
  return tx.knowledgeTopicRevision.create({
    data: {
      topicId: topic.id, revision: topic.revision, name: topic.name,
      description: topic.description, status: topic.status, mergedIntoId: topic.mergedIntoId,
      members: topic.members as unknown as Prisma.InputJsonValue,
      action: metadata.action,
      operationId: metadata.operationId ?? null,
      relatedTopicId: metadata.relatedTopicId ?? null,
    },
  });
}

export async function listKnowledgeTopicRevisions(
  prisma: PrismaClient, characterId: string, topicId: string, limit = 50,
) {
  const topic = await prisma.knowledgeTopic.findFirst({
    where: { id: topicId, characterId }, select: { id: true, revision: true },
  });
  if (!topic) fail(404, "主题不存在。");
  const revisions = await prisma.knowledgeTopicRevision.findMany({
    where: { topicId },
    orderBy: [{ revision: "desc" }],
    take: Math.min(Math.max(limit, 1), 100),
    select: {
      id: true, revision: true, name: true, description: true, status: true,
      mergedIntoId: true, members: true, action: true, operationId: true,
      relatedTopicId: true, createdAt: true,
    },
  });
  return {
    topicId,
    currentRevision: topic.revision,
    revisions: revisions.map(({ members, ...revision }) => ({
      ...revision,
      memberCount: Array.isArray(members) ? members.length : 0,
    })),
  };
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
      mergedIntoId: true, members: true, action: true, operationId: true,
      relatedTopicId: true, createdAt: true,
    },
  });
  if (!snapshot) fail(404, "主题历史版本不存在。");
  return { topicId, currentRevision: topic.revision, snapshot };
}

/**
 * 按 revision 号把主题恢复到任意历史版本：先保存当前版本快照，再以新 revision 写回所选版本。
 * 适合管理页面「恢复此版本」，只影响单个主题。
 */
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

    await saveCurrent(tx, topic, { action: "RESTORE" });
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

/**
 * 按历史快照 ID 撤销一笔操作：拆分与合并共用 operationId，撤销时在一个事务里恢复全部关联主题。
 * 只允许撤销紧邻的上一笔操作；关联主题之后又发生变化时整笔拒绝。
 */
export async function revertKnowledgeTopicOperation(
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
  const expectedRevision = input.expectedRevision as number;

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
    if (primary.revision !== expectedRevision) fail(409, "主题已发生变化，请刷新历史后重试。");

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
      await saveCurrent(tx, current, {
        action: "RESTORE",
        operationId: restoreOperationId,
        relatedTopicId: snapshot.topicId === topicId ? snapshot.relatedTopicId : topicId,
      });
    }
    if (selected.action === "SPLIT") {
      const created = byId.get(selected.relatedTopicId!)!;
      await saveCurrent(tx, created, { action: "RESTORE", operationId: restoreOperationId, relatedTopicId: topicId });
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
