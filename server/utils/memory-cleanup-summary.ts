/** 最近一次原始消息清理的结果：从审计里读，只读、不改任何数据。 */

import type { PrismaClient } from "../../src/generated/prisma/client";

export type CleanupSummary = {
  at: string;
  cutoff: string | null;
  deletedMessages: number | null;
  contextMessages: number | null;
  contextCutoff: string | null;
};

function countOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : null;
}
function timeOf(value: unknown): string | null {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : null;
}

/**
 * Worker 把每次清理写在 `message.retention_cleanup` 上，实体是**记忆范围**而不是角色：
 * 一个角色有全局 + 私人多个范围，谁先清理就记谁，所以取该角色全部范围里最新的一条。
 */
export async function readLatestCleanupSummary(
  prisma: Pick<PrismaClient, "memoryScope" | "auditLog">,
  characterId: string,
): Promise<CleanupSummary | null> {
  const scopes = await prisma.memoryScope.findMany({ where: { characterId }, select: { id: true } });
  if (!scopes.length) return null;
  const latest = await prisma.auditLog.findFirst({
    where: { action: "message.retention_cleanup", entityType: "MemoryScope", entityId: { in: scopes.map(scope => scope.id) } },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true, details: true },
  });
  if (!latest) return null;
  const details = (latest.details ?? {}) as Record<string, unknown>;
  return {
    at: latest.createdAt.toISOString(),
    cutoff: timeOf(details.cutoff),
    deletedMessages: countOf(details.deletedMessages),
    contextMessages: countOf(details.contextMessages),
    contextCutoff: timeOf(details.contextCutoff),
  };
}
