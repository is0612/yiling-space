import { createError } from "h3";
import { Prisma, type PrismaClient } from "../../src/generated/prisma/client";
import { buildPage } from "./pagination";

export const GROWTH_DELIVERY_STATUSES = ["QUEUED", "RUNNING", "SUCCEEDED", "RETRY_WAIT", "FAILED", "SKIPPED", "CANCELLED"] as const;
export type GrowthDeliveryStatus = typeof GROWTH_DELIVERY_STATUSES[number];

const deliverySelect = {
  id: true, eventId: true, consumerKey: true, status: true, attemptCount: true, maxAttempts: true,
  runAt: true, lockedAt: true, lockedBy: true, leaseExpiresAt: true, fencingToken: true,
  lastError: true, processedAt: true, createdAt: true, updatedAt: true,
  event: { select: { eventType: true, sourceDomain: true, aggregateType: true, aggregateId: true, occurredAt: true } },
} satisfies Prisma.GrowthEventDeliverySelect;
type DeliveryRow = Prisma.GrowthEventDeliveryGetPayload<{ select: typeof deliverySelect }>;

function toItem(row: DeliveryRow, now: Date) {
  const { event, ...delivery } = row;
  const waiting = row.status === "QUEUED" || row.status === "RETRY_WAIT";
  return {
    ...delivery, ...event,
    runAt: row.runAt.toISOString(), lockedAt: row.lockedAt?.toISOString() ?? null,
    leaseExpiresAt: row.leaseExpiresAt?.toISOString() ?? null, processedAt: row.processedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), occurredAt: event.occurredAt.toISOString(),
    leaseExpired: row.status === "RUNNING" && (!row.leaseExpiresAt || row.leaseExpiresAt <= now),
    queueDelayMs: waiting ? Math.max(0, now.getTime() - row.runAt.getTime()) : 0,
  };
}

export async function requireOwnedGrowthCharacter(prisma: PrismaClient, ownerId: string, characterId: string) {
  const character = await prisma.character.findFirst({ where: { id: characterId, ownerId }, select: { id: true } });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });
}

export async function listGrowthDeliveries(
  prisma: PrismaClient,
  input: { ownerId: string; characterId: string; page: number; pageSize: number; status?: GrowthDeliveryStatus; now?: Date },
) {
  await requireOwnedGrowthCharacter(prisma, input.ownerId, input.characterId);
  const now = input.now ?? new Date();
  const base: Prisma.GrowthEventDeliveryWhereInput = { event: { is: { characterId: input.characterId, character: { is: { ownerId: input.ownerId } } } } };
  const where = { ...base, ...(input.status ? { status: input.status } : {}) };
  const ready: Prisma.GrowthEventDeliveryWhereInput = { ...base, status: { in: ["QUEUED", "RETRY_WAIT"] }, runAt: { lte: now } };
  const [rows, total, groups, readyCount, stuckCount, oldest] = await Promise.all([
    prisma.growthEventDelivery.findMany({ where, select: deliverySelect, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (input.page - 1) * input.pageSize, take: input.pageSize }),
    prisma.growthEventDelivery.count({ where }),
    prisma.growthEventDelivery.groupBy({ by: ["status"], where: base, _count: { _all: true } }),
    prisma.growthEventDelivery.count({ where: ready }),
    prisma.growthEventDelivery.count({ where: { ...base, status: "RUNNING", OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }] } }),
    prisma.growthEventDelivery.findFirst({ where: ready, orderBy: [{ runAt: "asc" }, { id: "asc" }], select: { runAt: true } }),
  ]);
  const statusCounts = Object.fromEntries(GROWTH_DELIVERY_STATUSES.map(status => [status, 0])) as Record<GrowthDeliveryStatus, number>;
  for (const group of groups) statusCounts[group.status] = group._count._all;
  return {
    ...buildPage(rows.map(row => toItem(row, now)), total, input.page, input.pageSize),
    summary: { statusCounts, readyCount, stuckCount, oldestReadyAt: oldest?.runAt.toISOString() ?? null },
  };
}

export async function readGrowthDelivery(
  prisma: PrismaClient,
  input: { ownerId: string; characterId: string; deliveryId: string; now?: Date },
) {
  await requireOwnedGrowthCharacter(prisma, input.ownerId, input.characterId);
  const row = await prisma.growthEventDelivery.findFirst({
    where: { id: input.deliveryId, event: { is: { characterId: input.characterId, character: { is: { ownerId: input.ownerId } } } } },
    select: deliverySelect,
  });
  if (!row) throw createError({ statusCode: 404, statusMessage: "投递不存在。" });
  const audits = await prisma.auditLog.findMany({
    where: { characterId: input.characterId, entityId: row.id, entityType: "GrowthEventDelivery", action: "growth.event_delivery.manual_retry" },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 50,
    select: { id: true, actorType: true, actorId: true, createdAt: true, details: true },
  });
  return { ...toItem(row, input.now ?? new Date()), audits: audits.map(audit => ({ ...audit, createdAt: audit.createdAt.toISOString() })) };
}
