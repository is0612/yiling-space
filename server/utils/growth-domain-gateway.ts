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
