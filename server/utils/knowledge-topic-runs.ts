import { createError } from "h3";
import { Prisma, type PrismaClient } from "../../src/generated/prisma/client";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function createKnowledgeTopicRun(prisma: PrismaClient, characterId: string, rawItemIds: unknown) {
  if (!Array.isArray(rawItemIds) || rawItemIds.length < 1 || rawItemIds.length > 50
    || rawItemIds.some(id => typeof id !== "string" || !UUID.test(id))
    || new Set(rawItemIds).size !== rawItemIds.length) {
    throw createError({ statusCode: 400, statusMessage: "请选择 1–50 条不重复的正式知识。" });
  }
  const itemIds = rawItemIds as string[];
  return prisma.$transaction(async tx => {
    const rows = await tx.$queryRaw<Array<{ id: string; revision: number }>>`
      SELECT "id", "revision" FROM "knowledge_items"
      WHERE "characterId" = ${characterId}::uuid AND "status" = 'ACTIVE'
        AND "id" = ANY(${itemIds}::uuid[])
      ORDER BY "id" FOR SHARE
    `;
    if (rows.length !== itemIds.length) {
      throw createError({ statusCode: 409, statusMessage: "所选知识中有条目已删除、归档或不属于当前角色，请刷新后重试。" });
    }
    const revisions = new Map(rows.map(row => [row.id, row.revision]));
    const inputSnapshot = itemIds.map(itemId => ({ itemId, revision: revisions.get(itemId)! }));
    return tx.knowledgeTopicRun.create({
      data: { characterId, inputSnapshot: inputSnapshot as unknown as Prisma.InputJsonValue },
      select: { id: true, status: true, createdAt: true },
    });
  }, { timeout: 10_000 });
}
