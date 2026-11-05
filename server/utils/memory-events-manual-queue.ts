import type { PrismaClient } from "../../src/generated/prisma/client";
import { eventMessageWhere } from "./memory-event-source";

/** Manual queueing shares the scheduler's keys; it never creates click-specific jobs. */
export async function queueManualMemoryEvents(
  prisma: Pick<PrismaClient, "message" | "memoryJob" | "memoryEventDay" | "$queryRaw" | "$executeRaw">,
  input: {
    memoryScopeId: string; privateOnly: boolean; dayKey: string;
    idempotencyKey: string; periodStart: Date; periodEnd: Date;
    hourly: boolean; now: Date;
  },
): Promise<string | null> {
  const where = eventMessageWhere({ ...input, progress: null });
  if (!await prisma.message.findFirst({ where, select: { id: true } })) return null;
  const created = await prisma.memoryJob.createMany({
    data: [{
      memoryScopeId: input.memoryScopeId, type: "EXTRACT_EVENTS",
      idempotencyKey: input.idempotencyKey, periodStart: input.periodStart,
      periodEnd: input.periodEnd, status: "QUEUED", runAt: input.now,
    }],
    skipDuplicates: true,
  });
  // Keep PostgreSQL's full microsecond version: JS Date truncates legacy timestamps.
  const [job] = await prisma.$queryRaw<Array<{
    id: string; memoryScopeId: string; type: string; status: string;
    updatedAt: Date; version: string;
  }>>`SELECT id, "memoryScopeId", type, status, "updatedAt", "updatedAt"::text AS version
      FROM memory_jobs WHERE "idempotencyKey" = ${input.idempotencyKey}`;
  if (!job || job.memoryScopeId !== input.memoryScopeId || job.type !== "EXTRACT_EVENTS") return null;
  if (created.count) return job.id;
  const waiting = job.status === "QUEUED" || job.status === "RETRY_WAIT";
  const completedHour = input.hourly && (job.status === "SUCCEEDED" || job.status === "SKIPPED");
  if (!waiting && !completedHour) return null;
  if (completedHour) {
    const progress = await prisma.memoryEventDay.findUnique({
      where: { memoryScopeId_dayKey: { memoryScopeId: input.memoryScopeId, dayKey: input.dayKey } },
      select: { extractedAt: true, extractedMessageId: true },
    });
    if (!await prisma.message.findFirst({
      where: eventMessageWhere({ ...input, progress }), select: { id: true },
    })) return null;
  }
  // CAS prevents a stale request from changing a worker's claim or a user's cancellation.
  // Force a different timestamp even when two operations happen within one millisecond.
  const updatedAt = new Date(Math.max(input.now.getTime(), job.updatedAt.getTime() + 1));
  const changed = await prisma.$executeRaw`
    UPDATE memory_jobs SET status = 'QUEUED', "runAt" = ${input.now},
      "lockedAt" = NULL, "lockedBy" = NULL, "updatedAt" = ${updatedAt},
      "attemptCount" = CASE WHEN ${completedHour} THEN 0 ELSE "attemptCount" END,
      "startedAt" = CASE WHEN ${completedHour} THEN NULL ELSE "startedAt" END,
      "completedAt" = CASE WHEN ${completedHour} THEN NULL ELSE "completedAt" END,
      "lastError" = CASE WHEN ${completedHour} THEN NULL ELSE "lastError" END
    WHERE id = ${job.id}::uuid AND status::text = ${job.status}
      AND "updatedAt" = ${job.version}::timestamptz`;
  return changed ? job.id : null;
}
