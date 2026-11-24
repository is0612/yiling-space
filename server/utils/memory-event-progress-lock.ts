import type { Prisma } from "../../src/generated/prisma/client";

export type EventDayProgress = {
  state: "DRAFT" | "FINAL";
  extractedAt: Date | null;
  extractedMessageId: string | null;
} | null;

export class MemoryEventProgressConflictError extends Error {
  constructor() {
    super("忆泡日期进度已被其他任务推进，将重新读取进度后继续整理。");
    this.name = "MemoryEventProgressConflictError";
  }
}

/** Call after the job lease lock, before any domain write. Never hold this lock across model I/O. */
export async function lockExpectedEventDayProgress(
  tx: Prisma.TransactionClient,
  memoryScopeId: string,
  dayKey: string,
  expected: EventDayProgress,
): Promise<void> {
  // Match snapshot writes: job first, then scope. This also serializes a missing day row.
  // NO KEY UPDATE stays compatible with FK KEY SHARE checks when events link other participants' scopes.
  await tx.$queryRaw`SELECT id FROM "memory_scopes" WHERE id = ${memoryScopeId}::uuid FOR NO KEY UPDATE`;
  const actual = await tx.memoryEventDay.findUnique({
    where: { memoryScopeId_dayKey: { memoryScopeId, dayKey } },
    select: { state: true, extractedAt: true, extractedMessageId: true },
  });
  if (actual?.state === "FINAL"
    || (actual?.state ?? null) !== (expected?.state ?? null)
    || (actual?.extractedAt?.getTime() ?? null) !== (expected?.extractedAt?.getTime() ?? null)
    || (actual?.extractedMessageId ?? null) !== (expected?.extractedMessageId ?? null)) {
    throw new MemoryEventProgressConflictError();
  }
}
