import type { Prisma } from "../../src/generated/prisma/client";

/**
 * 记忆领域对外的最小来源读取 DTO。
 * 事件消费者不能直接把 MemoryEvent Prisma Model 当成跨领域协议使用；
 * 这里按 Character.id 限定来源，并明确保留 ACTIVE / ARCHIVED 状态。
 */
export type MemoryEventReference = {
  id: string;
  characterId: string;
  memoryScopeId: string;
  status: "ACTIVE" | "ARCHIVED";
  occurredAt: Date;
  createdAt: Date;
};

export async function readMemoryEventReference(
  tx: Prisma.TransactionClient,
  characterId: string,
  memoryEventId: string,
): Promise<MemoryEventReference | null> {
  const row = await tx.memoryEvent.findFirst({
    where: {
      id: memoryEventId,
      memoryScope: { is: { characterId } },
    },
    select: {
      id: true,
      memoryScopeId: true,
      status: true,
      occurredAt: true,
      createdAt: true,
      memoryScope: { select: { characterId: true } },
    },
  });
  if (!row) return null;
  return {
    id: row.id,
    characterId: row.memoryScope.characterId,
    memoryScopeId: row.memoryScopeId,
    status: row.status,
    occurredAt: row.occurredAt,
    createdAt: row.createdAt,
  };
}

/** 仅公开角色范围的有效来源可被人工提出为角色全局知识候选。 */
export async function readPublicMemoryKnowledgeSource(
  tx: Prisma.TransactionClient,
  characterId: string,
  memoryEventId: string,
) {
  const scopes = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT scope."id" FROM "memory_scopes" AS scope
    INNER JOIN "memory_events" AS source ON source."memoryScopeId" = scope."id"
    WHERE source."id" = ${memoryEventId}::uuid
      AND scope."characterId" = ${characterId}::uuid
      AND scope."scopeType" = 'CHARACTER_GLOBAL'::"MemoryScopeType"
    FOR SHARE OF scope
  `;
  if (!scopes.length) return null;
  const rows = await tx.$queryRaw<Array<{ id: string; title: string; detail: string; occurredAt: Date; memoryScopeId: string }>>`
    SELECT source."id", source."title", source."detail", source."occurredAt", source."memoryScopeId"
    FROM "memory_events" AS source
    INNER JOIN "memory_scopes" AS scope ON scope."id" = source."memoryScopeId"
    WHERE source."id" = ${memoryEventId}::uuid AND source."status" = 'ACTIVE'
      AND scope."characterId" = ${characterId}::uuid
      AND scope."scopeType" = 'CHARACTER_GLOBAL'::"MemoryScopeType"
      AND scope."id" = ${scopes[0]!.id}::uuid
    FOR SHARE OF source
  `;
  return rows[0] ?? null;
}
